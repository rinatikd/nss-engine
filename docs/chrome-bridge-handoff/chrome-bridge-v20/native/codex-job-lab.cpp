// Lab-only native Codex process launch proof. No MCP/production integration.
// Launches ONLY a pinned, direct-release codex.exe with --version.
// Build: cl /nologo /std:c++17 /EHsc /W4 /WX codex-job-lab.cpp /link wintrust.lib crypt32.lib
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wintrust.h>
#include <softpub.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include <iostream>
#include <string>
#include <vector>
#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "bcrypt.lib")

struct Handle {
    HANDLE h = nullptr;
    explicit Handle(HANDLE v = nullptr) : h(v) {}
    ~Handle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
static const wchar_t* expectedHash =
    L"9D563EE4E0441FF9D59D612013E0460DDF8E5709735C2D9F6B98B7EF8CA4EB42";
static bool hashFile(const std::wstring& file) {
    Handle h(CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!h.h || h.h == INVALID_HANDLE_VALUE) return false;
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    bool ok = false;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return false;
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
        BYTE buf[65536]; DWORD n = 0; bool readOk = true;
        for (;;) {
            if (!ReadFile(h.h, buf, sizeof(buf), &n, nullptr)) { readOk = false; break; }
            if (!n) break;
            if (BCryptHashData(hash, buf, n, 0) != 0) { readOk = false; break; }
        }
        BYTE digest[32]{};
        if (readOk && BCryptFinishHash(hash, digest, sizeof(digest), 0) == 0) {
            static const wchar_t* hex = L"0123456789ABCDEF";
            std::wstring actual;
            for (BYTE b : digest) { actual += hex[b >> 4]; actual += hex[b & 15]; }
            ok = actual == expectedHash;
        }
        BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}
static bool signatureValid(const std::wstring& file) {
    WINTRUST_FILE_INFO fi{};
    fi.cbStruct = sizeof(fi);
    fi.pcwszFilePath = file.c_str();
    WINTRUST_DATA data{};
    data.cbStruct = sizeof(data);
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.pFile = &fi;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN;
    GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    const LONG status = WinVerifyTrust(nullptr, &action, &data);
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust(nullptr, &action, &data);
    return status == ERROR_SUCCESS;
}
static bool noReparse(const std::wstring& file) {
    if (file.size() < 4 || file[1] != L':' || file[2] != L'\\') return false;
    for (size_t i = 3; i <= file.size(); ++i) {
        if (i != file.size() && file[i] != L'\\') continue;
        const auto part = file.substr(0, i);
        const DWORD attrs = GetFileAttributesW(part.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    }
    return true;
}
static bool jobEmpty(HANDLE job) {
    for (int i = 0; i < 120; ++i) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                       &info, sizeof(info), nullptr)) return false;
        if (!info.ActiveProcesses) return true;
        Sleep(25);
    }
    return false;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2) { std::wcerr << L"Usage: codex-job-lab.exe DIRECT_RELEASE_CODEX_EXE\n"; return 2; }
    const std::wstring exe(argv[1]);
    if (exe.find(L'"') != std::wstring::npos ||
        exe.find(L"..") != std::wstring::npos ||
        exe.find(L"\\\\") == 0 ||
        exe.size() < 9 || exe.substr(exe.size() - 9) != L"codex.exe" ||
        !noReparse(exe)) { std::wcerr << L"CODEX_PATH_DENIED\n"; return 20; }
    if (!hashFile(exe)) { std::wcerr << L"CODEX_HASH_DENIED\n"; return 21; }
    if (!signatureValid(exe)) { std::wcerr << L"CODEX_SIGNATURE_DENIED\n"; return 22; }
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.h) return 23;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
    lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &lim, sizeof(lim))) return 24;
    // No inherited handles, shell, user-supplied arguments, workspace writes or prompt.
    std::wstring command = L"\"" + exe + L"\" --version";
    STARTUPINFOW si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, FALSE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr,
                        &si, &pi)) { std::wcerr << L"CODEX_CREATE_FAILED\n"; return 25; }
    Handle child(pi.hProcess), thread(pi.hThread);
    if (!AssignProcessToJobObject(job.h, child.h)) {
        TerminateProcess(child.h, 1);
        WaitForSingleObject(child.h, 5000);
        return 26;
    }
    if (ResumeThread(thread.h) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.h, 1);
        return 27;
    }
    std::wcout << L"CODEX_JOB_LAUNCHED_PID: " << pi.dwProcessId << L"\n";
    DWORD wait = WaitForSingleObject(child.h, 15000);
    if (wait != WAIT_OBJECT_0) {
        TerminateJobObject(job.h, 9);
        WaitForSingleObject(child.h, 5000);
        std::wcerr << L"CODEX_JOB_TIMEOUT_OR_WAIT_ERROR\n";
        return 28;
    }
    DWORD exitCode = 1;
    if (!GetExitCodeProcess(child.h, &exitCode)) return 29;
    // Kill any descendants even after main process exits.
    if (!TerminateJobObject(job.h, 9)) return 30;
    if (!jobEmpty(job.h)) return 31;
    if (exitCode != 0) { std::wcerr << L"CODEX_EXIT_NONZERO\n"; return 32; }
    std::wcout << L"CODEX_JOB_CLEANUP_VERIFIED\n";
    std::wcout << L"CODEX_LAB_VERSION_LAUNCH_PASS\n";
    std::wcout << L"PRODUCTION_CHANGED: NO\n";
    return 0;
}
