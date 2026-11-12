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

struct ScopedHandle {
    HANDLE h = nullptr;
    explicit ScopedHandle(HANDLE value = nullptr) : h(value) {}
    ~ScopedHandle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
    ScopedHandle(const ScopedHandle&) = delete;
    ScopedHandle& operator=(const ScopedHandle&) = delete;
};

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
int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--contained-child") {
        Sleep(30000);
        return 0;
    }
    if (argc != 2 || std::wstring(argv[1]) != L"--selftest") {
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
    std::wcout << L"SUPERVISOR_SELFTEST_PASS\n";
    return 0;
}
