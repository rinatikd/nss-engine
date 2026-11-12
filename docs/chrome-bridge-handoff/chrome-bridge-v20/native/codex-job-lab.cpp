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
#include <array>
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
static bool readCaptured(HANDLE file, const wchar_t* label) {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file, &size) || size.QuadPart > 65536) return false;
    LARGE_INTEGER origin{};
    if (!SetFilePointerEx(file, origin, nullptr, FILE_BEGIN)) return false;
    std::array<char, 65537> buffer{};
    DWORD count = 0;
    if (!ReadFile(file, buffer.data(), 65536, &count, nullptr)) return false;
    std::cout << "CODEX_" << (label[0] == L'O' ? "STDOUT" : "STDERR")
              << "_BYTES: " << count << "\n";
    if (count) std::cout.write(buffer.data(), count);
    if (label[0] == L'E' && count) {
        const std::string diagnostic(buffer.data(), count);
        if (diagnostic.find("usage limit") != std::string::npos) {
            std::cout << "CODEX_FAILURE_CLASS: USAGE_LIMIT_EXCEEDED\n";
        }
    }
    if (count && buffer[count - 1] != '\n') std::cout << "\n";
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
// Deterministic native Job Object negative-path tests: no Codex, no network.
static int selfTest(const std::wstring& mode, const std::wstring& self, const std::wstring& cancelName = L"") {
    Handle cancel;
    if (mode == L"--selftest-external-cancel") {
        if (cancelName.rfind(L"Local\\CB_CodexLabCancel_", 0) != 0 || cancelName.size() > 110) return 80;
        cancel.h = CreateEventW(nullptr, TRUE, FALSE, cancelName.c_str());
        if (!cancel.h || GetLastError() == ERROR_ALREADY_EXISTS) return 81;
        std::wcout << L"CODEX_EXTERNAL_CANCEL_READY\n" << std::flush;
    }
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.h) return 70;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
    lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &lim, sizeof(lim))) return 71;
    std::wstring cmd = L"\"" + self + L"\" --selftest-child";
    STARTUPINFOW si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(self.c_str(), cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr,
                        &si, &pi)) return 72;
    Handle child(pi.hProcess), thread(pi.hThread);
    if (!AssignProcessToJobObject(job.h, child.h)) {
        TerminateProcess(child.h, 1);
        WaitForSingleObject(child.h, 5000);
        return 73;
    }
    if (ResumeThread(thread.h) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.h, 1);
        return 74;
    }
    const DWORD wait = mode == L"--selftest-external-cancel"
        ? WaitForSingleObject(cancel.h, 120000)
        : WaitForSingleObject(child.h, mode == L"--selftest-timeout" ? 200 : 50);
    if (wait != (mode == L"--selftest-external-cancel" ? WAIT_OBJECT_0 : WAIT_TIMEOUT)) {
        TerminateJobObject(job.h, 1);
        return 75;
    }
    if (!TerminateJobObject(job.h, 9)) return 76;
    if (WaitForSingleObject(child.h, 5000) != WAIT_OBJECT_0) return 77;
    if (!jobEmpty(job.h)) return 78;
    if (mode == L"--selftest-timeout") std::wcout << L"CODEX_JOB_TIMEOUT_CLEANUP_PASS\n";
    else if (mode == L"--selftest-external-cancel") std::wcout << L"CODEX_JOB_EXTERNAL_CANCEL_CLEANUP_PASS\n";
    else std::wcout << L"CODEX_JOB_CANCEL_CLEANUP_PASS\n";
    std::wcout << L"CODEX_NOT_INVOKED\n";
    return 0;
}
int wmain(int argc, wchar_t** argv) {
    if (argc == 3 && std::wstring(argv[1]) == L"--selftest-external-cancel") {
        wchar_t self[MAX_PATH]{};
        const DWORD n = GetModuleFileNameW(nullptr, self, MAX_PATH);
        if (!n || n >= MAX_PATH) return 79;
        return selfTest(argv[1], self, argv[2]);
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--selftest-child") {
        Sleep(180000);
        return 0;
    }
    if (argc == 2 && (std::wstring(argv[1]) == L"--selftest-timeout" ||
                      std::wstring(argv[1]) == L"--selftest-cancel")) {
        wchar_t self[MAX_PATH]{};
        const DWORD n = GetModuleFileNameW(nullptr, self, MAX_PATH);
        if (!n || n >= MAX_PATH) return 79;
        return selfTest(argv[1], self);
    }

    if (argc != 2 && argc != 4) { std::wcerr << L"Usage: codex-job-lab.exe DIRECT_RELEASE_CODEX_EXE [--exec-lab LAB_DIRECTORY]\\n"; return 2; }
    const bool execLab = argc == 4;
    if (execLab && std::wstring(argv[2]) != L"--exec-lab") return 2;
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
    // Fixed prompt only. Read-only Codex sandbox is not an OS isolation boundary.
    std::wstring command = L"\"" + exe + L"\" --version";
    std::wstring labDir;
    if (execLab) {
        labDir = argv[3];
        if (labDir.size() < 4 || labDir[1] != L':' || labDir[2] != L'\\' ||
            labDir.find(L"..") != std::wstring::npos ||
            labDir.find(L'"') != std::wstring::npos) return 38;
        const DWORD attrs = GetFileAttributesW(labDir.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY) ||
            (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) return 39;
        command = L"\"" + exe + L"\" exec --skip-git-repo-check --sandbox read-only --ephemeral "
                  L"\"Reply with exactly: CODEX_BRIDGE_OK\"";
    }
    // Redirect stdin to NUL; capture stdout/stderr into separate bounded temp files.
    // File handles are inherited only by the lab child; no shell is involved.
    wchar_t tempPath[MAX_PATH]{};
    if (!GetTempPathW(MAX_PATH, tempPath)) return 33;
    wchar_t stdoutName[MAX_PATH]{}, stderrName[MAX_PATH]{};
    if (!GetTempFileNameW(tempPath, L"cbo", 0, stdoutName)) return 34;
    if (!GetTempFileNameW(tempPath, L"cbe", 0, stderrName)) {
        DeleteFileW(stdoutName);
        return 35;
    }
    struct TempCleanup {
        std::wstring a, b;
        ~TempCleanup() { if (!a.empty()) DeleteFileW(a.c_str()); if (!b.empty()) DeleteFileW(b.c_str()); }
    } cleanup{stdoutName, stderrName};
    SECURITY_ATTRIBUTES sa{}; sa.nLength = sizeof(sa); sa.bInheritHandle = TRUE;
    Handle output(CreateFileW(stdoutName, GENERIC_READ | GENERIC_WRITE,
                              FILE_SHARE_READ, &sa, TRUNCATE_EXISTING,
                              FILE_ATTRIBUTE_TEMPORARY, nullptr));
    Handle error(CreateFileW(stderrName, GENERIC_READ | GENERIC_WRITE,
                             FILE_SHARE_READ, &sa, TRUNCATE_EXISTING,
                             FILE_ATTRIBUTE_TEMPORARY, nullptr));
    Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             &sa, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!output.h || output.h == INVALID_HANDLE_VALUE ||
        !error.h || error.h == INVALID_HANDLE_VALUE ||
        !input.h || input.h == INVALID_HANDLE_VALUE) return 36;
    STARTUPINFOW si{}; si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = input.h;
    si.hStdOutput = output.h;
    si.hStdError = error.h;
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe.c_str(), command.data(), nullptr, nullptr, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                        execLab ? labDir.c_str() : nullptr,
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
    DWORD wait = WaitForSingleObject(child.h, execLab ? 90000 : 15000);
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
    std::wcout << L"CODEX_JOB_CLEANUP_VERIFIED\n";
    if (!readCaptured(output.h, L"OUT") || !readCaptured(error.h, L"ERR")) {
        std::wcerr << L"CODEX_CAPTURE_FAILED_OR_TOO_LARGE\n";
        return 37;
    }
    if (exitCode != 0) { std::wcerr << L"CODEX_EXIT_NONZERO\n"; return 32; }
    if (execLab) {
        std::wcout << L"CODEX_LAB_EXEC_PROCESS_PASS\n";
        std::wcout << L"CODEX_LAB_RESPONSE_REQUIRES_OPERATOR_REVIEW\n";
    } else {
        std::wcout << L"CODEX_LAB_VERSION_LAUNCH_PASS\n";
    }
    std::wcout << L"CODEX_LAB_CAPTURE_PASS\n";
    // Close the capture handles before temporary-file cleanup.
    CloseHandle(output.h); output.h = nullptr;
    CloseHandle(error.h); error.h = nullptr;
    std::wcout << L"PRODUCTION_CHANGED: NO\n";
    return 0;
}
