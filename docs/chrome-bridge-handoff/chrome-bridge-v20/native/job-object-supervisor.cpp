// Windows-only local supervisor proof of concept. No Codex, network, elevation or MCP.
// This test executable deliberately runs ONLY itself as a child.
// It demonstrates: suspended launch -> Job assignment -> resume -> terminate -> verify.
// Build with MSVC: cl /nologo /std:c++17 /EHsc /W4 /WX job-object-supervisor.cpp
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <string>
#include <regex>

struct ScopedHandle {
    HANDLE h = nullptr;
    explicit ScopedHandle(HANDLE value = nullptr) : h(value) {}
    ~ScopedHandle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;
};

// IPC v1.5.2 lab-only durable restart gate. The caller supplies a private
// absolute marker path; no production defaults or automatic stale-marker reset.
static bool reserveGate(const wchar_t* marker) {
    HANDLE file = CreateFileW(marker, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    const char payload[] = R"({"schema":1,"state":"unclean"})";
    DWORD written = 0;
    const BOOL ok = WriteFile(file, payload, sizeof(payload) - 1, &written, nullptr) &&
                    written == sizeof(payload) - 1 && FlushFileBuffers(file);
    CloseHandle(file);
    // On write failure leave marker in place: fail closed.
    return ok != 0;
}
static int error(const wchar_t* step, int code) {
    std::wcerr << step << L" failed Win32=" << GetLastError() << L"\n";
    return code;
}
static bool emptyJob(HANDLE job, DWORD timeoutMs) {
    const ULONGLONG deadline = GetTickCount64() + timeoutMs;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                       &info, sizeof(info), nullptr)) return false;
        if (info.ActiveProcesses == 0) return true;
        if (GetTickCount64() >= deadline) return false;
        Sleep(25);
    }
}
// Deliberately restricted IPC proof: the only permitted executable is this binary,
// and the only permitted child argument is --contained-child. NOT a general runner.
// This lightweight parser is for the fixed test protocol, not untrusted production JSON.
static bool field(const std::string& line, const char* name, std::string& value) {
    const std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*\"([A-Za-z0-9_-]{1,80})\"");
    std::smatch match;
    if (!std::regex_search(line, match, pattern)) return false;
    value = match[1].str();
    return true;
}
static int ipcSelfOnly(const wchar_t* exe) {
    std::string line;
    if (!std::getline(std::cin, line) || line.size() > 65536) return 20;
    std::string type, requestId;
    if (!field(line, "type", type) || type != "launch" ||
        !field(line, "requestId", requestId) ||
        line.find("\"--contained-child\"") == std::string::npos) return 21;
    // Require a JSON-escaped copy of the supervisor's own absolute executable path.
    std::wstring own(exe);
    std::string escaped;
    for (wchar_t c : own) {
        if (c > 127) return 22; // test path must be ASCII for this restricted proof
        if (c == L'\\') escaped += "\\\\";
        else if (c == L'"') escaped += "\\\"";
        else escaped += static_cast<char>(c);
    }
    if (line.find("\"executable\":\"" + escaped + "\"") == std::string::npos) return 23;
    ScopedHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.h) return 24;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 25;
    std::wstring cmd = L"\"" + own + L"\" --contained-child";
    STARTUPINFOW si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe, cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) return 26;
    ScopedHandle process(pi.hProcess), thread(pi.hThread);
    if (!AssignProcessToJobObject(job.h, process.h)) {
        TerminateProcess(process.h, 1);
        WaitForSingleObject(process.h, 5000);
        return 27;
    }
    if (ResumeThread(thread.h) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.h, 1);
        return 28;
    }
    std::cout << "{\"type\":\"ready\",\"requestId\":\"" << requestId
              << "\",\"pid\":" << pi.dwProcessId << ",\"contained\":true}" << std::endl;
    if (!std::getline(std::cin, line) || line.size() > 65536 ||
        !field(line, "type", type) || type != "terminate" ||
        !field(line, "requestId", type) || type != requestId) {
        // Kill-on-close guarantees cleanup even if parent disconnects.
        return 29;
    }
    if (!TerminateJobObject(job.h, 9)) return 30;
    if (WaitForSingleObject(process.h, 5000) != WAIT_OBJECT_0 || !emptyJob(job.h, 3000)) return 31;
    std::cout << "{\"type\":\"terminated\",\"requestId\":\"" << requestId
              << "\",\"verified\":true,\"activeProcesses\":0}" << std::endl;
    return 0;
}
int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--contained-child") {
        Sleep(30000);
        return 0;
    }
    if (argc == 2 && std::wstring(argv[1]) == L"--stdio-v1") {
        wchar_t exePath[MAX_PATH]{};
        DWORD n = GetModuleFileNameW(nullptr, exePath, MAX_PATH);
        if (!n || n >= MAX_PATH) return 19;
        return ipcSelfOnly(exePath);
    }
    const bool gated = argc == 3 && std::wstring(argv[1]) == L"--gated-selftest";
    const wchar_t* marker = gated ? argv[2] : nullptr;
    if (gated) {
        // This selftest-only mode deliberately refuses an existing marker.
        if (!marker || !*marker || !reserveGate(marker)) {
            std::wcerr << L"GATE_DENIED: existing or unwriteable reservation\n";
            return 40;
        }
        std::wcout << L"GATE_RESERVED\n";
    }
    if (!gated && (argc != 2 || std::wstring(argv[1]) != L"--selftest")) {
        std::wcerr << L"Usage: job-object-supervisor.exe --selftest\n";
        return 2;
    }
    wchar_t exe[MAX_PATH]{};
    const DWORD length = GetModuleFileNameW(nullptr, exe, MAX_PATH);
    if (!length || length >= MAX_PATH) return error(L"GetModuleFileNameW", 3);
    ScopedHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.h) return error(L"CreateJobObjectW", 4);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) return error(L"SetInformationJobObject", 5);
    std::wstring command = L"\"" + std::wstring(exe) + L"\" --contained-child";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION processInfo{};
    if (!CreateProcessW(exe, command.data(), nullptr, nullptr, FALSE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr,
                        &startup, &processInfo)) return error(L"CreateProcessW", 6);
    ScopedHandle process(processInfo.hProcess);
    ScopedHandle thread(processInfo.hThread);
    if (!AssignProcessToJobObject(job.h, process.h)) {
        const int code = error(L"AssignProcessToJobObject", 7);
        TerminateProcess(process.h, 1);
        WaitForSingleObject(process.h, 5000);
        return code;
    }
    if (ResumeThread(thread.h) == static_cast<DWORD>(-1)) {
        const int code = error(L"ResumeThread", 8);
        TerminateJobObject(job.h, 1);
        WaitForSingleObject(process.h, 5000);
        return code;
    }
    if (WaitForSingleObject(process.h, 200) != WAIT_TIMEOUT) {
        std::wcerr << L"Child exited unexpectedly\n";
        return 9;
    }
    if (!TerminateJobObject(job.h, 9)) return error(L"TerminateJobObject", 10);
    if (WaitForSingleObject(process.h, 5000) != WAIT_OBJECT_0) {
        std::wcerr << L"Child termination unconfirmed\n";
        return 11;
    }
    if (!emptyJob(job.h, 3000)) {
        std::wcerr << L"Job Object accounting not empty\n";
        return 12;
    }
    if (gated) {
        // The child handle has signaled and OS job accounting reached zero.
        // A deletion failure keeps the reservation and denies further starts.
        if (!DeleteFileW(marker)) return error(L"DeleteFileW", 41);
        std::wcout << L"GATE_RELEASED_OS_VERIFIED\n";
    }
    std::wcout << L"SUPERVISOR_SELFTEST_PASS\n";
    return 0;
}
