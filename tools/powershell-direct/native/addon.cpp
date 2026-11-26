#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <node_api.h>

namespace {
napi_value get_build_info(napi_env env, napi_callback_info) {
  napi_value result, platform, arch, napi_version, backend;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, "win32", NAPI_AUTO_LENGTH, &platform);
  napi_create_string_utf8(env, "x64", NAPI_AUTO_LENGTH, &arch);
  napi_create_uint32(env, NAPI_VERSION, &napi_version);
  napi_create_string_utf8(env, "job-object-bootstrap-only", NAPI_AUTO_LENGTH, &backend);
  napi_set_named_property(env, result, "platform", platform);
  napi_set_named_property(env, result, "arch", arch);
  napi_set_named_property(env, result, "napiVersion", napi_version);
  napi_set_named_property(env, result, "backend", backend);
  return result;
}

napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"getBuildInfo", nullptr, get_build_info, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  if (napi_define_properties(env, exports, 1, properties) != napi_ok) return nullptr;
  return exports;
}
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
