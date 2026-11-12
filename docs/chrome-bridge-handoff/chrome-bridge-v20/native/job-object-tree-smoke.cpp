// Windows Job Object second-level descendant proof. Self-only, no Codex or production.
// Build: cl /nologo /std:c++17 /EHsc /W4 /WX job-object-tree-smoke.cpp
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <string>
struct Handle {
    HANDLE h = nullptr;
    explicit Handle(HANDLE value = nullptr) : h(value) {}
    ~Handle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};
static bool spawn(const wchar_t* exe, const wchar_t* mode, DWORD flags,
                  PROCESS_INFORMATION& out) {
    std::wstring cmd = L"\"" + std::wstring(exe) + L"\" " + mode;
    STARTUPINFOW si{}; si.cb = sizeof(si);
    return CreateProcessW(exe, cmd.data(), nullptr, nullptr, FALSE,
                          flags | CREATE_NO_WINDOW, nullptr, nullptr, &si, &out) != 0;
}
static bool active(HANDLE job, DWORD expected, DWORD timeout) {
    const ULONGLONG deadline = GetTickCount64() + timeout;
    do {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                       &info, sizeof(info), nullptr)) return false;
        if (info.ActiveProcesses == expected) return true;
        Sleep(25);
    } while (GetTickCount64() < deadline);
    return false;
}
int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--grandchild") {
        Sleep(30000);
        return 0;
    }
    wchar_t exe[MAX_PATH]{};
    const DWORD n = GetModuleFileNameW(nullptr, exe, MAX_PATH);
    if (!n || n >= MAX_PATH) return 10;
    if (argc == 2 && std::wstring(argv[1]) == L"--child") {
        PROCESS_INFORMATION grandchild{};
        if (!spawn(exe, L"--grandchild", 0, grandchild)) return 11;
        Handle gp(grandchild.hProcess), gt(grandchild.hThread);
        Sleep(30000);
        return 0;
    }
    if (argc != 2 || std::wstring(argv[1]) != L"--selftest") return 2;
    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.h) return 20;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.h, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) return 21;
    PROCESS_INFORMATION child{};
    if (!spawn(exe, L"--child", CREATE_SUSPENDED, child)) return 22;
    Handle cp(child.hProcess), ct(child.hThread);
    if (!AssignProcessToJobObject(job.h, cp.h)) {
        TerminateProcess(cp.h, 1);
        WaitForSingleObject(cp.h, 5000);
        return 23;
    }
    if (ResumeThread(ct.h) == static_cast<DWORD>(-1)) {
        TerminateJobObject(job.h, 9);
        return 24;
    }
    if (!active(job.h, 2, 5000)) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
        const BOOL queried = QueryInformationJobObject(job.h, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr);
        std::wcerr << L"DIAGNOSTIC: queried=" << queried << L" active="
                   << (queried ? info.ActiveProcesses : 0) << L" total="
                   << (queried ? info.TotalProcesses : 0) << L" childExit=";
        DWORD childExit = STILL_ACTIVE;
        if (GetExitCodeProcess(cp.h, &childExit)) std::wcerr << childExit;
        else std::wcerr << L"unavailable";
        std::wcerr << L" win32=" << GetLastError() << L"\n";
        TerminateJobObject(job.h, 9);
        std::wcerr << L"Expected two active processes in job (child + grandchild)\n";
        return 25;
    }
    // Close the last job handle, exercising KILL_ON_JOB_CLOSE (not TerminateJobObject).
    CloseHandle(job.h);
    job.h = nullptr;
    if (WaitForSingleObject(cp.h, 5000) != WAIT_OBJECT_0) return 26;
    // Independent OS-level check for the entire job: a handle to the grandchild is
    // unavailable here, so this test proves accounting reached 2 before job close
    // and the immediate child died; grandchild PID liveness remains to be verified.
    std::wcout << L"TREE_SMOKE_PARTIAL_PASS: job contained 2 active processes; "
                  L"job handle closed; child terminated; grandchild PID unverified\n";
    return 0;
}
