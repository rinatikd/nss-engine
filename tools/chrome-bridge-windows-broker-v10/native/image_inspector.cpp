// Read-only Windows image inspector for the Chrome Bridge broker staging work.
// It deliberately has no process creation, token, job, or execution code.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wintrust.h>
#include <softpub.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include <memory>
#include <cwctype>
#include <cctype>

#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace {
struct Handle {
  HANDLE value{INVALID_HANDLE_VALUE};
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  operator HANDLE() const { return value; }
};
struct LocalMem { PVOID value{}; ~LocalMem() { if (value) LocalFree(value); } };
struct WinTrustState {
  WINTRUST_DATA data{};
  bool opened{};
  ~WinTrustState() {
    if (opened) {
      data.dwStateAction = WTD_STATEACTION_CLOSE;
      WinVerifyTrust(nullptr, &WINTRUST_ACTION_GENERIC_VERIFY_V2, &data);
    }
  }
};

std::string hex(const BYTE* p, size_t n) {
  std::ostringstream s; s << std::hex << std::setfill('0');
  for (size_t i=0;i<n;i++) s << std::setw(2) << (unsigned)p[i];
  return s.str();
}
bool sidString(PSID sid, std::wstring& out) {
  LPWSTR text{};
  if (!sid || !ConvertSidToStringSidW(sid, &text)) return false;
  out = text; LocalFree(text); return true;
}
bool hashHandle(HANDLE file, std::string& result) {
  BCRYPT_ALG_HANDLE alg{}; BCRYPT_HASH_HANDLE hash{};
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return false;
  DWORD objectBytes=0, got=0, hashBytes=0;
  bool ok = BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, (PUCHAR)&objectBytes, sizeof(objectBytes), &got, 0)==0 &&
            BCryptGetProperty(alg, BCRYPT_HASH_LENGTH, (PUCHAR)&hashBytes, sizeof(hashBytes), &got, 0)==0;
  std::vector<UCHAR> object(objectBytes), digest(hashBytes);
  if (ok) ok = BCryptCreateHash(alg, &hash, object.data(), objectBytes, nullptr, 0, 0)==0;
  LARGE_INTEGER zero{};
  if (ok) ok = SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)!=0;
  std::vector<UCHAR> buf(1024*1024); DWORD n=0;
  while (ok) {
    if (!ReadFile(file, buf.data(), (DWORD)buf.size(), &n, nullptr)) { ok=false; break; }
    if (!n) break;
    ok = BCryptHashData(hash, buf.data(), n, 0)==0;
  }
  if (ok) ok = BCryptFinishHash(hash, digest.data(), hashBytes, 0)==0;
  if (ok) result = hex(digest.data(), digest.size());
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(alg, 0);
  return ok;
}
bool signerHash(WINTRUST_DATA& state, std::string& result) {
  auto provFn = reinterpret_cast<decltype(&WTHelperProvDataFromStateData)>(GetProcAddress(GetModuleHandleW(L"wintrust.dll"), "WTHelperProvDataFromStateData"));
  auto signerFn = reinterpret_cast<decltype(&WTHelperGetProvSignerFromChain)>(GetProcAddress(GetModuleHandleW(L"wintrust.dll"), "WTHelperGetProvSignerFromChain"));
  if (!provFn || !signerFn) return false;
  CRYPT_PROVIDER_DATA* prov = provFn(state.hWVTStateData);
  CRYPT_PROVIDER_SGNR* signer = prov ? signerFn(prov, 0, FALSE, 0) : nullptr;
  if (!signer || signer->csCertChain==0 || !signer->pasCertChain[0].pCert) return false;
  PCCERT_CONTEXT cert = signer->pasCertChain[0].pCert;
  BYTE digest[32]; DWORD cb=sizeof(digest);
  if (!CryptHashCertificate2(BCRYPT_SHA256_ALGORITHM, 0, nullptr, cert->pbCertEncoded, cert->cbCertEncoded, digest, &cb)) return false;
  result = hex(digest, cb); return true;
}
bool checkAcl(HANDLE file, const std::wstring& expectedOwner, bool& protectedDacl, std::wstring& ownerText) {
  PSID owner{}; PACL dacl{}; PSECURITY_DESCRIPTOR raw{};
  LocalMem sd;
  DWORD rc=GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,
                           &owner, nullptr, &dacl, nullptr, &raw);
  sd.value=raw;
  if (rc!=ERROR_SUCCESS || !owner || !dacl || !IsValidAcl(dacl)) return false;
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision{};
  if (!GetSecurityDescriptorControl((PSECURITY_DESCRIPTOR)raw, &control, &revision)) return false;
  protectedDacl=(control & SE_DACL_PROTECTED)!=0;
  if (!sidString(owner, ownerText) || ownerText!=expectedOwner) return false;
  // Fail closed: allow only explicit, ordinary allow ACEs for the pinned owner and LocalSystem;
  // deny ACEs, inherited ACEs, object/callback ACEs, and every unknown ACE form are rejected.
  for (DWORD i=0;i<dacl->AceCount;i++) {
    void* ptr{}; if (!GetAce(dacl, i, &ptr)) return false;
    auto header=(ACE_HEADER*)ptr;
    if (header->AceType!=ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & INHERITED_ACE)) return false;
    auto ace=(ACCESS_ALLOWED_ACE*)ptr;
    PSID trustee=(PSID)&ace->SidStart;
    std::wstring trusteeText; if (!sidString(trustee, trusteeText)) return false;
    std::wstring systemSid=L"S-1-5-18";
    if (trusteeText!=expectedOwner && trusteeText!=systemSid) return false;
    constexpr DWORD writeMask=FILE_WRITE_DATA|FILE_APPEND_DATA|FILE_WRITE_EA|FILE_WRITE_ATTRIBUTES|FILE_DELETE_CHILD|DELETE|WRITE_DAC|WRITE_OWNER|GENERIC_WRITE|GENERIC_ALL;
    if (ace->Mask & writeMask) return false;
  }
  return protectedDacl;
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc!=6) { std::wcerr << L"usage: image_inspector.exe <candidate-path> <pinned-sha256> <pinned-signer-cert-sha256> <pinned-owner-sid> <pinned-final-path>\n"; return 64; }
  const std::wstring path=argv[1], expectedHash=argv[2], expectedSigner=argv[3], expectedOwner=argv[4], expectedFinalPath=argv[5];
  if (expectedHash.size()!=64 || expectedSigner.size()!=64 || expectedOwner.empty() || expectedFinalPath.empty()) return 64;
  Handle file{CreateFileW(path.c_str(), GENERIC_READ|READ_CONTROL, FILE_SHARE_READ,
                          nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN, nullptr)};
  if (file.value==INVALID_HANDLE_VALUE) return 2;
  FILE_ATTRIBUTE_TAG_INFO tag{}; FILE_STANDARD_INFO standard{}; FILE_ID_INFO id{};
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id))) return 3;
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || standard.Directory || standard.NumberOfLinks!=1) return 4;
  std::wstring finalPath(32768, L'\0');
  DWORD finalLen=GetFinalPathNameByHandleW(file, finalPath.data(), (DWORD)finalPath.size(), FILE_NAME_NORMALIZED|VOLUME_NAME_GUID);
  if (!finalLen || finalLen>=finalPath.size()) return 5;
  finalPath.resize(finalLen); // Never emit the local path.
  if (CompareStringOrdinal(finalPath.c_str(), (int)finalPath.size(), expectedFinalPath.c_str(), (int)expectedFinalPath.size(), TRUE)!=CSTR_EQUAL) return 5;
  std::string actualHash;
  if (!hashHandle(file, actualHash)) return 6;
  std::string actualSigner;
  WINTRUST_FILE_INFO fi{}; fi.cbStruct=sizeof(fi); fi.pcwszFilePath=finalPath.c_str(); fi.hFile=file;
  WinTrustState trust; trust.data.cbStruct=sizeof(trust.data); trust.data.dwUIChoice=WTD_UI_NONE;
  trust.data.fdwRevocationChecks=WTD_REVOKE_WHOLECHAIN; trust.data.dwUnionChoice=WTD_CHOICE_FILE;
  trust.data.pFile=&fi; trust.data.dwStateAction=WTD_STATEACTION_VERIFY;
  trust.data.dwProvFlags=WTD_CACHE_ONLY_URL_RETRIEVAL|WTD_REVOCATION_CHECK_CHAIN;
  LONG trustResult=WinVerifyTrust(nullptr, &WINTRUST_ACTION_GENERIC_VERIFY_V2, &trust.data);
  trust.opened=true;
  bool protectedDacl=false; std::wstring ownerText;
  bool aclOk=checkAcl(file, expectedOwner, protectedDacl, ownerText);
  bool signerOk=trustResult==ERROR_SUCCESS && signerHash(trust.data, actualSigner);
  bool ownerOk=!ownerText.empty() && ownerText==expectedOwner;
  auto equalHex=[](const std::wstring& pin, const std::string& actual) {
    if (pin.size()!=actual.size()) return false;
    for (size_t i=0;i<actual.size();i++) if (towlower(pin[i])!=(wchar_t)tolower((unsigned char)actual[i])) return false;
    return true;
  };
  bool hashOk=equalHex(expectedHash, actualHash);
  bool signerPinOk=equalHex(expectedSigner, actualSigner);
  bool imageOk=hashOk && signerOk && signerPinOk;
  std::cout << "{\"schema\":\"windows-image-inspection/v1\",\"openedHandle\":true,\"reparsePoint\":false,\"singleLink\":true,\"handleBoundSha256\":\"" << actualHash
            << "\",\"sha256PinMatches\":" << (hashOk?"true":"false")
            << ",\"authenticodeTrusted\":" << (signerOk?"true":"false")
            << ",\"signerCertificateSha256\":\"" << actualSigner
            << "\",\"signerPinMatches\":" << (signerPinOk?"true":"false") << ",\"ownerPinMatches\":" << (ownerOk?"true":"false")
            << ",\"daclProtected\":" << (protectedDacl?"true":"false")
            << ",\"daclAllowlistValid\":" << (aclOk?"true":"false")
            << ",\"verificationComplete\":" << (imageOk && ownerOk && protectedDacl && aclOk ? "true":"false")
            << ",\"fileIdVolumeSerial\":\"" << std::hex << id.VolumeSerialNumber
            << "\",\"fileId\":\"" << hex(id.FileId.Identifier, sizeof(id.FileId.Identifier))
            << "\",\"executionAuthorized\":false,\"pathRedacted\":true}\n";
  return imageOk && ownerOk && protectedDacl && aclOk ? 0 : 10;
}
