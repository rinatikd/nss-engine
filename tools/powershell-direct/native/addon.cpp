#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <bcrypt.h>
#include <node_api.h>

#include <array>
#include <deque>
#include <mutex>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#pragma comment(lib, "bcrypt.lib")

namespace {
// Move-only HANDLE owner. A null/invalid handle is a no-op; ownership is
// transferred explicitly and every successfully adopted HANDLE is closed once.
class UniqueHandle {
 public:
  UniqueHandle() noexcept = default;
  explicit UniqueHandle(HANDLE handle) noexcept : handle_(handle) {}
  ~UniqueHandle() { reset(); }

  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  UniqueHandle(UniqueHandle&& other) noexcept
      : handle_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  HANDLE get() const noexcept { return handle_; }
  explicit operator bool() const noexcept {
    return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
  }
  HANDLE release() noexcept {
    HANDLE result = handle_;
    handle_ = nullptr;
    return result;
  }
  void reset(HANDLE replacement = nullptr) noexcept {
    if (*this) CloseHandle(handle_);
    handle_ = replacement;
  }

 private:
  HANDLE handle_ = nullptr;
};

static_assert(!std::is_copy_constructible<UniqueHandle>::value,
              "HANDLE ownership must not be copied");
static_assert(std::is_nothrow_move_constructible<UniqueHandle>::value,
              "HANDLE ownership transfer must be noexcept");

enum class OperationState {
  kRegistered,
  kStarting,
  kRunning,
  kTerminating,
  kCompleted,
  kClosed
};

struct OperationRecord {
  OperationState state = OperationState::kRegistered;

  // Declaration order is intentional: members are destroyed in reverse order,
  // so pipe endpoints and process/thread handles close before the Job HANDLE.
  // The job remains owned until the lifecycle implementation confirms that
  // the job is empty and output readers have reached EOF.
  UniqueHandle job;
  UniqueHandle process;
  UniqueHandle primary_thread;
  UniqueHandle stdout_read;
  UniqueHandle stdout_write;
  UniqueHandle stderr_read;
  UniqueHandle stderr_write;
};

std::mutex registry_mutex;
std::unordered_map<std::string, OperationRecord> active_operations;
std::unordered_set<std::string> closed_operations;
std::deque<std::string> closed_operation_order;
constexpr size_t kClosedOperationTombstoneLimit = 4096;

napi_value throw_error(napi_env env, const char* code, const char* message) {
  napi_value error, code_value, message_value;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
      napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
      napi_create_error(env, code_value, message_value, &error) != napi_ok) {
    napi_throw_error(env, code, message);
    return nullptr;
  }
  napi_throw(env, error);
  return nullptr;
}

bool make_operation_id(std::string& id) {
  std::array<unsigned char, 16> bytes{};
  if (BCryptGenRandom(nullptr, bytes.data(),
      static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
    return false;
  }
  static constexpr char hex[] = "0123456789abcdef";
  id.clear();
  id.reserve(bytes.size() * 2);
  for (const auto byte : bytes) {
    id.push_back(hex[(byte >> 4) & 0x0f]);
    id.push_back(hex[byte & 0x0f]);
  }
  return true;
}

napi_value create_operation(napi_env env, napi_callback_info) {
  std::string id;
  bool registered = false;
  for (int attempt = 0; attempt < 4; ++attempt) {
    if (!make_operation_id(id)) {
      return throw_error(env, "OPERATION_ID_GENERATION_FAILED",
                         "BCryptGenRandom failed");
    }
    std::lock_guard<std::mutex> lock(registry_mutex);
    if (active_operations.find(id) == active_operations.end() &&
        closed_operations.find(id) == closed_operations.end()) {
      active_operations.emplace(id, OperationRecord{});
      registered = true;
      break;
    }
  }
  if (!registered) {
    return throw_error(env, "OPERATION_ID_COLLISION",
                       "Could not allocate a unique operation ID");
  }
  napi_value result;
  if (napi_create_string_utf8(env, id.c_str(), id.size(), &result) != napi_ok) {
    std::lock_guard<std::mutex> lock(registry_mutex);
    active_operations.erase(id);
    return throw_error(env, "NAPI_STRING_CREATION_FAILED",
                       "Could not return the operation ID");
  }
  return result;
}

napi_value close_operation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 1) {
    return throw_error(env, "INVALID_ARGUMENT",
                       "closeOperation requires one operation ID");
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string) {
    return throw_error(env, "INVALID_ARGUMENT",
                       "operation ID must be a string");
  }
  size_t length = 0;
  napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length);
  if (length != 32) {
    return throw_error(env, "INVALID_OPERATION_ID",
                       "operation ID must contain 32 hexadecimal characters");
  }
  std::string id(length + 1, '\0');
  size_t copied = 0;
  napi_get_value_string_utf8(env, argv[0], id.data(), id.size(), &copied);
  id.resize(copied);
  for (const char c : id) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return throw_error(env, "INVALID_OPERATION_ID",
                         "operation ID must be lowercase hexadecimal");
    }
  }

  {
    std::lock_guard<std::mutex> lock(registry_mutex);
    const auto active = active_operations.find(id);
    if (active != active_operations.end()) {
      active_operations.erase(active);
      closed_operations.insert(id);
      closed_operation_order.push_back(id);
      while (closed_operation_order.size() > kClosedOperationTombstoneLimit) {
        closed_operations.erase(closed_operation_order.front());
        closed_operation_order.pop_front();
      }
    } else if (closed_operations.find(id) == closed_operations.end()) {
      return throw_error(env, "UNKNOWN_OPERATION",
                         "operation ID is not registered");
    }
  }
  napi_value result;
  napi_get_boolean(env, true, &result);
  return result;
}

napi_value get_build_info(napi_env env, napi_callback_info) {
  napi_value result, platform, arch, napi_version, backend;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, "win32", NAPI_AUTO_LENGTH, &platform);
  napi_create_string_utf8(env, "x64", NAPI_AUTO_LENGTH, &arch);
  napi_create_uint32(env, NAPI_VERSION, &napi_version);
  napi_create_string_utf8(env, "job-object-registry-bootstrap", NAPI_AUTO_LENGTH, &backend);
  napi_set_named_property(env, result, "platform", platform);
  napi_set_named_property(env, result, "arch", arch);
  napi_set_named_property(env, result, "napiVersion", napi_version);
  napi_set_named_property(env, result, "backend", backend);
  return result;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"getBuildInfo", nullptr, get_build_info, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createOperation", nullptr, create_operation, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeOperation", nullptr, close_operation, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return nullptr;
  return exports;
}
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
