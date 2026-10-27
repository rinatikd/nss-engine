// TEST-ONLY Windows launcher prototype. Never point this at Codex or user software.
// A release build is intentionally impossible without a separately generated
// test_pins.h and CHROME_BRIDGE_V12_DISPOSABLE_VM_BUILD.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wintrust.h>
#include <softpub.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <appmodel.h>
#include <sddl.h>
#include <aclapi.h>
#include <userenv.h>
#include <initializer_list>
#include <iterator>
#include <string>
#include <vector>
#include <array>
#include <algorithm>
#include <cstdio>
#include <cwchar>
#include <cwctype>
#include <cstring>
#include <objbase.h>

#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "ole32.lib")

#if __has_include("test_pins.h")
#include "test_pins.h"
#define HAVE_TEST_PINS 1
#else
#define HAVE_TEST_PINS 0
namespace v12pins {
constexpr wchar_t kWorkerPath[] = L"";
constexpr wchar_t kWorkerSha256[] = L"0000000000000000000000000000000000000000000000000000000000000000";
constexpr wchar_t kSignerCertSha256[] = L"0000000000000000000000000000000000000000000000000000000000000000";
}
#endif

#if !defined(CHROME_BRIDGE_V12_DISPOSABLE_VM_BUILD)
#define VM_BUILD_ENABLED 0
#else
#define VM_BUILD_ENABLED 1
#endif

namespace {
struct Handle final {
  HANDLE h{INVALID_HANDLE_VALUE};
  Handle() = default;
  explicit Handle(HANDLE value) : h(value) {}
  ~Handle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : h(other.release()) {}
  Handle& operator=(Handle&& other) noexcept { if (this != &other) { reset(); h = other.release(); } return *this; }
  HANDLE get() const { return h; }
  HANDLE release() { HANDLE v = h; h = INVALID_HANDLE_VALUE; return v; }
  void reset() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); h = INVALID_HANDLE_VALUE; }
};

struct AppProfile final {
  std::wstring name;
  PSID sid{nullptr};
  bool removeOnExit{false};
  ~AppProfile() {
    if (sid) FreeSid(sid);
    if (removeOnExit && !name.empty()) DeleteAppContainerProfile(name.c_str());
  }
};

struct AttributeList final {
  LPPROC_THREAD_ATTRIBUTE_LIST value{nullptr};
  SIZE_T bytes{0};
  bool initialized{false};
  ~AttributeList() {
    if (initialized) DeleteProcThreadAttributeList(value);
    if (value) HeapFree(GetProcessHeap(), 0, value);
  }
};

struct Workspace final {
  std::wstring path;
  ~Workspace() {
    if (!path.empty()) {
      DeleteFileW((path + L"\\worker-marker.txt").c_str());
      RemoveDirectoryW(path.c_str());
    }
  }
};

void Rollback(PROCESS_INFORMATION& pi, HANDLE job);
struct ProcessRollback final {
  PROCESS_INFORMATION* info;
  HANDLE job;
  ~ProcessRollback() { if (info && info->hProcess) Rollback(*info, job); }
};

constexpr DWORD kMaxImageBytes = 128u * 1024u * 1024u;
constexpr wchar_t kProfilePrefix[] = L"CBV12-SYNTHETIC-";
constexpr wchar_t kProbeArg[] = L"--synthetic-probe";

void Deny(const wchar_t* reason) {
  std::fwprintf(stderr, L"BLOCKED:%ls\n", reason);
}

bool EqualHex(const BYTE* bytes, size_t count, const wchar_t* expected) {
  static constexpr wchar_t hex[] = L"0123456789abcdef";
  if (!expected || wcslen(expected) != count * 2) return false;
  for (size_t i = 0; i < count; ++i) {
    if (expected[i * 2] != hex[bytes[i] >> 4] || expected[i * 2 + 1] != hex[bytes[i] & 15]) return false;
  }
  return true;
}

bool HashHandle(HANDLE file, std::array<BYTE, 32>& digest) {
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD objectSize = 0, got = 0;
  std::vector<BYTE> object;
  bool ok = false;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) goto done;
  if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &got, 0) < 0 || got != sizeof(objectSize)) goto done;
  object.resize(objectSize);
  if (BCryptCreateHash(alg, &hash, object.data(), objectSize, nullptr, 0, 0) < 0) goto done;
  if (SetFilePointerEx(file, LARGE_INTEGER{0}, nullptr, FILE_BEGIN) == FALSE) goto done;
  for (;;) {
    std::array<BYTE, 64 * 1024> chunk{};
    DWORD read = 0;
    if (!ReadFile(file, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr)) goto done;
    if (!read) break;
    if (BCryptHashData(hash, chunk.data(), read, 0) < 0) goto done;
  }
  if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) goto done;
  ok = true;
done:
  if (hash) BCryptDestroyHash(hash);
  if (alg) BCryptCloseAlgorithmProvider(alg, 0);
  return ok;
}

bool FileId(HANDLE file, FILE_ID_INFO& id) {
  return GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) != FALSE;
}

bool SameId(const FILE_ID_INFO& a, const FILE_ID_INFO& b) {
  return a.VolumeSerialNumber == b.VolumeSerialNumber &&
         memcmp(&a.FileId, &b.FileId, sizeof(a.FileId)) == 0;
}

std::wstring FinalVolumePath(HANDLE file) {
  DWORD needed = GetFinalPathNameByHandleW(file, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!needed || needed > 32768) return {};
  std::wstring result(needed, L'\0');
  DWORD written = GetFinalPathNameByHandleW(file, result.data(), needed, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!written || written >= needed) return {};
  result.resize(written);
  return result;
}

// Wintrust's helper accessors are documented as potentially changeable. Missing
// symbols or absent chain data deny launch; this prototype never falls back to
// subject-name text or JSON evidence.
bool VerifyTrustAndPinnedLeaf(HANDLE file, const std::wstring& path, const wchar_t* certSha256) {
  WINTRUST_FILE_INFO fileInfo{};
  fileInfo.cbStruct = sizeof(fileInfo);
  fileInfo.pcwszFilePath = path.c_str();
  fileInfo.hFile = file;
  WINTRUST_DATA data{};
  data.cbStruct = sizeof(data);
  data.dwUIChoice = WTD_UI_NONE;
  data.dwUnionChoice = WTD_CHOICE_FILE;
  data.dwStateAction = WTD_STATEACTION_VERIFY;
  data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE;
  data.pFile = &fileInfo;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = WinVerifyTrust(nullptr, &action, &data);
  bool trusted = status == ERROR_SUCCESS;
  if (trusted) {
    using GetProvData = CRYPT_PROVIDER_DATA* (WINAPI*)(HANDLE);
    using GetSigner = CRYPT_PROVIDER_SGNR* (WINAPI*)(CRYPT_PROVIDER_DATA*, DWORD, BOOL, DWORD);
    using GetCert = CRYPT_PROVIDER_CERT* (WINAPI*)(CRYPT_PROVIDER_SGNR*, DWORD);
    HMODULE module = GetModuleHandleW(L"wintrust.dll");
    auto getData = module ? reinterpret_cast<GetProvData>(GetProcAddress(module, "WTHelperProvDataFromStateData")) : nullptr;
    auto getSigner = module ? reinterpret_cast<GetSigner>(GetProcAddress(module, "WTHelperGetProvSignerFromChain")) : nullptr;
    auto getCert = module ? reinterpret_cast<GetCert>(GetProcAddress(module, "WTHelperGetProvCertFromChain")) : nullptr;
    CRYPT_PROVIDER_DATA* provider = getData ? getData(data.hWVTStateData) : nullptr;
    CRYPT_PROVIDER_SGNR* signer = (provider && getSigner) ? getSigner(provider, 0, FALSE, 0) : nullptr;
    CRYPT_PROVIDER_CERT* cert = (signer && getCert && signer->csCertChain) ? getCert(signer, 0) : nullptr;
    std::array<BYTE, 32> digest{};
    BCRYPT_ALG_HANDLE hashAlg = nullptr;
    const bool hashReady = BCryptOpenAlgorithmProvider(&hashAlg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0;
    trusted = signer && signer->dwError == ERROR_SUCCESS && cert && cert->pCert &&
      cert->pCert->pbCertEncoded && cert->pCert->cbCertEncoded &&
      hashReady && BCryptHash(hashAlg, nullptr, 0, cert->pCert->pbCertEncoded,
                 cert->pCert->cbCertEncoded, digest.data(), static_cast<ULONG>(digest.size())) >= 0 &&
      EqualHex(digest.data(), digest.size(), certSha256);
    if (hashAlg) BCryptCloseAlgorithmProvider(hashAlg, 0);
  }
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  const LONG closeStatus = WinVerifyTrust(nullptr, &action, &data);
  return trusted && closeStatus == ERROR_SUCCESS;
}

bool VerifyPinnedWorker(HANDLE file, std::wstring& finalPath, FILE_ID_INFO& originalId) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  BY_HANDLE_FILE_INFORMATION oldInfo{};
  LARGE_INTEGER size{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !GetFileInformationByHandle(file, &oldInfo) || oldInfo.nNumberOfLinks != 1 ||
      !GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > kMaxImageBytes ||
      !FileId(file, originalId)) return false;
  finalPath = FinalVolumePath(file);
  if (finalPath.empty() || finalPath.rfind(L"\\\\?\\Volume{", 0) != 0) return false;
  std::array<BYTE, 32> digest{};
  if (!HashHandle(file, digest) || !EqualHex(digest.data(), digest.size(), v12pins::kWorkerSha256)) return false;
  return VerifyTrustAndPinnedLeaf(file, finalPath, v12pins::kSignerCertSha256);
}

bool VerifyChildImage(HANDLE process, HANDLE pinnedFile, const FILE_ID_INFO& originalId) {
  std::vector<wchar_t> path(32768);
  DWORD chars = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process, 0, path.data(), &chars) || chars == 0 || chars >= path.size()) return false;
  Handle reopened(CreateFileW(path.data(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (reopened.get() == INVALID_HANDLE_VALUE) return false;
  FILE_ID_INFO childId{};
  if (!FileId(reopened.get(), childId) || !SameId(originalId, childId)) return false;
  std::array<BYTE, 32> digest{};
  return HashHandle(pinnedFile, digest) && EqualHex(digest.data(), digest.size(), v12pins::kWorkerSha256);
}

bool SetJobLimits(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
      JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_PROCESS_TIME;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  limits.BasicLimitInformation.PerProcessUserTimeLimit.QuadPart = 60LL * 10'000'000;
  limits.ProcessMemoryLimit = 256ULL * 1024 * 1024;
  // No BREAKAWAY_OK or SILENT_BREAKAWAY_OK bit is set.
  return SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE;
}

bool VerifyJobLimits(HANDLE job) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  DWORD returned = 0;
  if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), &returned) ||
      returned != sizeof(limits)) return false;
  const DWORD required = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
      JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_PROCESS_TIME;
  const DWORD forbidden = JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  return (limits.BasicLimitInformation.LimitFlags & required) == required &&
      (limits.BasicLimitInformation.LimitFlags & forbidden) == 0 &&
      limits.BasicLimitInformation.ActiveProcessLimit == 1 &&
      limits.ProcessMemoryLimit == 256ULL * 1024 * 1024;
}

std::wstring GuidName() {
  GUID guid{};
  if (CoCreateGuid(&guid) != S_OK) return {};
  wchar_t value[64]{};
  if (StringFromGUID2(guid, value, static_cast<int>(std::size(value))) == 0) return {};
  std::wstring name = kProfilePrefix;
  for (const wchar_t c : std::wstring(value)) if (iswalnum(c)) name.push_back(c);
  return name;
}

bool MakeAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST& list, SIZE_T& bytes,
                       HANDLE* handles, SIZE_T handleCount,
                       HANDLE* jobs, SIZE_T jobCount,
                       SECURITY_CAPABILITIES& capabilities,
                       DWORD& lpacPolicy) {
  constexpr DWORD count = 4;
  InitializeProcThreadAttributeList(nullptr, count, 0, &bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes == 0) return false;
  list = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes));
  if (!list) return false;
  if (!InitializeProcThreadAttributeList(list, count, 0, &bytes)) {
    HeapFree(GetProcessHeap(), 0, list); list = nullptr; return false;
  }
  auto fail = [&]() { DeleteProcThreadAttributeList(list); HeapFree(GetProcessHeap(), 0, list); list = nullptr; return false; };
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles,
      handleCount * sizeof(HANDLE), nullptr, nullptr)) return fail();
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs,
      jobCount * sizeof(HANDLE), nullptr, nullptr)) return fail();
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
      &capabilities, sizeof(capabilities), nullptr, nullptr)) return fail();
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
      &lpacPolicy, sizeof(lpacPolicy), nullptr, nullptr)) return fail();
  return true;
}

void Rollback(PROCESS_INFORMATION& pi, HANDLE job) {
  if (pi.hProcess) {
    if (job) TerminateJobObject(job, ERROR_PROCESS_ABORTED);
    else TerminateProcess(pi.hProcess, ERROR_PROCESS_ABORTED);
    WaitForSingleObject(pi.hProcess, 10000);
  }
  if (pi.hThread) CloseHandle(pi.hThread);
  if (pi.hProcess) CloseHandle(pi.hProcess);
  pi = {};
}

bool CreatePrivateWorkspace(PSID appSid, Workspace& workspace) {
  wchar_t base[32768]{};
  DWORD count = GetTempPath2W(static_cast<DWORD>(std::size(base)), base);
  if (!count || count >= std::size(base) || wcsncmp(base, L"\\\\", 2) == 0) return false;
  std::wstring basePath(base);
  if (basePath.back() != L'\\') basePath.push_back(L'\\');
  workspace.path = basePath + GuidName();
  if (!CreateDirectoryW(workspace.path.c_str(), nullptr)) { workspace.path.clear(); return false; }

  EXPLICIT_ACCESSW grant{};
  grant.grfAccessPermissions = FILE_ALL_ACCESS;
  grant.grfAccessMode = GRANT_ACCESS;
  grant.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  grant.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  grant.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
  grant.Trustee.ptstrName = static_cast<LPWSTR>(appSid);
  PACL oldDacl = nullptr, newDacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD status = GetNamedSecurityInfoW(workspace.path.data(), SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldDacl, nullptr, &descriptor);
  if (status == ERROR_SUCCESS) status = SetEntriesInAclW(1, &grant, oldDacl, &newDacl);
  if (status == ERROR_SUCCESS) status = SetNamedSecurityInfoW(workspace.path.data(), SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION, nullptr, nullptr, newDacl, nullptr);
  if (newDacl) LocalFree(newDacl);
  if (descriptor) LocalFree(descriptor);
  if (status != ERROR_SUCCESS) return false;

  Handle dir(CreateFileW(workspace.path.c_str(), FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (dir.get() == INVALID_HANDLE_VALUE) return false;
  FILE_ATTRIBUTE_TAG_INFO tag{};
  PSECURITY_DESCRIPTOR observedDescriptor = nullptr;
  PACL observedDacl = nullptr;
  DWORD aclStatus = GetSecurityInfo(dir.get(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    nullptr, nullptr, &observedDacl, nullptr, &observedDescriptor);
  bool packageAceFound = false;
  if (aclStatus == ERROR_SUCCESS && observedDacl) {
    for (DWORD i = 0; i < observedDacl->AceCount; ++i) {
      void* rawAce = nullptr;
      if (!GetAce(observedDacl, i, &rawAce) || !rawAce) { aclStatus = ERROR_INVALID_ACL; break; }
      auto* header = static_cast<ACE_HEADER*>(rawAce);
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        PSID sid = &ace->SidStart;
        if (EqualSid(sid, appSid) && (ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS) packageAceFound = true;
      }
    }
  }
  const std::wstring finalPath = FinalVolumePath(dir.get());
  const bool valid = aclStatus == ERROR_SUCCESS && packageAceFound &&
    GetFileInformationByHandleEx(dir.get(), FileAttributeTagInfo, &tag, sizeof(tag)) &&
    !(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
    !finalPath.empty() && finalPath.rfind(L"\\\\?\\Volume{", 0) == 0;
  if (observedDescriptor) LocalFree(observedDescriptor);
  return valid;
}

int LaunchSyntheticProbe() {
  // Caller-controlled paths or commands are never accepted. The generated pin
  // header is only for an ephemeral, disposable-VM test certificate and worker.
  Handle image(CreateFileW(v12pins::kWorkerPath, GENERIC_READ, FILE_SHARE_READ, nullptr,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
  if (image.get() == INVALID_HANDLE_VALUE) { Deny(L"PINNED_IMAGE_OPEN_FAILED"); return 10; }
  std::wstring finalPath;
  FILE_ID_INFO imageId{};
  if (!VerifyPinnedWorker(image.get(), finalPath, imageId)) { Deny(L"IMAGE_PIN_OR_TRUST_FAILED"); return 11; }

  std::wstring profileName = GuidName();
  if (profileName.empty()) { Deny(L"PROFILE_ID_FAILED"); return 12; }
  AppProfile profile{};
  profile.name = profileName;
  HRESULT hr = CreateAppContainerProfile(profileName.c_str(), L"Disposable synthetic worker", L"ephemeral VM only", nullptr, 0, &profile.sid);
  profile.removeOnExit = SUCCEEDED(hr);
  if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) hr = DeriveAppContainerSidFromAppContainerName(profileName.c_str(), &profile.sid);
  if (FAILED(hr) || !profile.sid) { Deny(L"APPCONTAINER_PROFILE_FAILED"); return 13; }

  Workspace workspace{};
  if (!CreatePrivateWorkspace(profile.sid, workspace)) { Deny(L"PRIVATE_WORKSPACE_SETUP_FAILED"); return 14; }

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (job.get() == INVALID_HANDLE_VALUE || !SetJobLimits(job.get())) { Deny(L"JOB_LIMITS_FAILED"); return 30; }

  SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE childStdInRaw = nullptr, parentStdInRaw = nullptr, parentStdOutRaw = nullptr, childStdOutRaw = nullptr;
  HANDLE parentStdErrRaw = nullptr, childStdErrRaw = nullptr;
  if (!CreatePipe(&childStdInRaw, &parentStdInRaw, &inheritable, 4096) ||
      !CreatePipe(&parentStdOutRaw, &childStdOutRaw, &inheritable, 4096) ||
      !CreatePipe(&parentStdErrRaw, &childStdErrRaw, &inheritable, 4096)) {
    for (HANDLE h : {childStdInRaw, parentStdInRaw, parentStdOutRaw, childStdOutRaw, parentStdErrRaw, childStdErrRaw}) if (h) CloseHandle(h);
    Deny(L"STDIO_PIPE_FAILED"); return 31;
  }
  Handle childStdIn(childStdInRaw), parentStdIn(parentStdInRaw), parentStdOut(parentStdOutRaw), childStdOut(childStdOutRaw);
  Handle parentStdErr(parentStdErrRaw), childStdErr(childStdErrRaw);
  if (!SetHandleInformation(parentStdIn.get(), HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(parentStdOut.get(), HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(parentStdErr.get(), HANDLE_FLAG_INHERIT, 0)) {
    Deny(L"PARENT_PIPE_HANDLE_HARDENING_FAILED"); return 32;
  }

  SECURITY_CAPABILITIES secCaps{};
  secCaps.AppContainerSid = profile.sid;
  secCaps.Capabilities = nullptr;
  secCaps.CapabilityCount = 0;
  secCaps.Reserved = 0;
  DWORD lpacPolicy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
  HANDLE handleList[] = { childStdIn.get(), childStdOut.get(), childStdErr.get() };
  HANDLE jobList[] = { job.get() };
  // All inherited handles are created here, inheritable, and explicitly listed.
  LPPROC_THREAD_ATTRIBUTE_LIST attrs = nullptr;
  SIZE_T attrsBytes = 0;
  AttributeList attributeList{};
  if (!MakeAttributeList(attributeList.value, attributeList.bytes, handleList, std::size(handleList), jobList, 1, secCaps, lpacPolicy)) {
    Deny(L"STARTUP_ATTRIBUTE_SETUP_FAILED"); return 32;
  }
  attributeList.initialized = true;
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = childStdIn.get();
  si.StartupInfo.hStdOutput = childStdOut.get();
  si.StartupInfo.hStdError = childStdErr.get();
  si.lpAttributeList = attributeList.value;
  // Environment list is intentionally explicit and contains no inherited
  // PATH, HOME, CODEX_HOME, credential, proxy, or token variables.
  wchar_t systemRoot[32768]{};
  UINT n = GetSystemWindowsDirectoryW(systemRoot, static_cast<UINT>(std::size(systemRoot)));
  if (!n || n >= std::size(systemRoot)) { Deny(L"SYSTEM_ROOT_UNAVAILABLE"); return 33; }
  std::vector<wchar_t> envBlock;
  auto addEnv = [&envBlock](const std::wstring& item) { envBlock.insert(envBlock.end(), item.begin(), item.end()); envBlock.push_back(L'\0'); };
  addEnv(L"CB_V12_SYNTHETIC_ONLY=1");
  addEnv(L"CB_WORKSPACE=" + workspace.path);
  addEnv(L"SystemRoot=" + std::wstring(systemRoot));
  envBlock.push_back(L'\0');
  std::wstring command = L"\"" + finalPath + L"\" " + kProbeArg;
  std::vector<wchar_t> mutableCommand(command.begin(), command.end()); mutableCommand.push_back(L'\0');
  PROCESS_INFORMATION pi{};
  ProcessRollback processRollback{&pi, job.get()};
  const BOOL created = CreateProcessW(finalPath.c_str(), mutableCommand.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
    envBlock.data(), workspace.path.c_str(), &si.StartupInfo, &pi);
  // Parent copies of child-side pipe handles close before we ever resume.
  childStdIn.reset();
  childStdOut.reset();
  childStdErr.reset();
  if (!created) { Deny(L"CREATE_PROCESS_FAILED"); return 34; }

  BOOL inJob = FALSE;
  if (!IsProcessInJob(pi.hProcess, job.get(), &inJob) || !inJob || !VerifyJobLimits(job.get()) ||
      !VerifyChildImage(pi.hProcess, image.get(), imageId)) {
    Deny(L"SUSPENDED_CHILD_IDENTITY_OR_JOB_CHECK_FAILED"); Rollback(pi, job.get()); return 35;
  }
  HANDLE tokenRaw = nullptr;
  if (!OpenProcessToken(pi.hProcess, TOKEN_QUERY, &tokenRaw)) {
    Deny(L"CHILD_TOKEN_QUERY_FAILED"); Rollback(pi, job.get()); return 36;
  }
  Handle token(tokenRaw);
  DWORD isApp = 0, returned = 0;
  if (!GetTokenInformation(token.get(), TokenIsAppContainer, &isApp, sizeof(isApp), &returned) || !isApp) {
    Deny(L"CHILD_NOT_APPCONTAINER"); Rollback(pi, job.get()); return 37;
  }
  // Check child image identity/hash one more time while candidate handle remains
  // held. Any uncertainty terminates the suspended process before ResumeThread.
  if (!VerifyChildImage(pi.hProcess, image.get(), imageId)) {
    Deny(L"PRE_RESUME_IMAGE_RECHECK_FAILED"); Rollback(pi, job.get()); return 38;
  }
  if (ResumeThread(pi.hThread) != 1) {
    Deny(L"RESUME_FAILED"); Rollback(pi, job.get()); return 39;
  }
  CloseHandle(pi.hThread); pi.hThread = nullptr;
  // This prototype waits only for the synthetic fixture and force-closes its
  // job on timeout. It does not supervise a real CLI or parse model output.
  DWORD wait = WaitForSingleObject(pi.hProcess, 30000);
  if (wait == WAIT_TIMEOUT) { Deny(L"SYNTHETIC_WORKER_TIMEOUT"); Rollback(pi, job.get()); return 40; }
  DWORD exitCode = ERROR_PROCESS_ABORTED;
  if (wait != WAIT_OBJECT_0 || !GetExitCodeProcess(pi.hProcess, &exitCode)) {
    Deny(L"SYNTHETIC_WORKER_WAIT_FAILED"); Rollback(pi, job.get()); return 41;
  }
  CloseHandle(pi.hProcess); pi.hProcess = nullptr;
  return exitCode == 0 ? 0 : 20;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 1) { Deny(L"ARGUMENTS_NOT_ACCEPTED"); return 2; }
#if !HAVE_TEST_PINS
  Deny(L"TEST_PINS_HEADER_MISSING");
  return 3;
#elif !VM_BUILD_ENABLED
  Deny(L"DISPOSABLE_VM_BUILD_FLAG_REQUIRED");
  return 4;
#else
  return LaunchSyntheticProbe();
#endif
}
