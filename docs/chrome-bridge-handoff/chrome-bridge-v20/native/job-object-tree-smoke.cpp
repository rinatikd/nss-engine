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
    // Observe both members only after accounting confirms two active processes.
    // Keep a SYNCHRONIZE handle to the grandchild to avoid PID-reuse races.
    BYTE buffer[sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 32]{};
    DWORD needed = 0;
    if (!QueryInformationJobObject(job.h, JobObjectBasicProcessIdList,
                                   buffer, sizeof(buffer), &needed)) {
        TerminateJobObject(job.h, 9);
        return 27;
    }
    auto* ids = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer);
    if (ids->NumberOfProcessIdsInList != 2) {
        TerminateJobObject(job.h, 9);
        return 28;
    }
    DWORD grandchildPid = 0;
    bool foundChild = false;
    for (DWORD i = 0; i < ids->NumberOfProcessIdsInList; ++i) {
        const DWORD pid = static_cast<DWORD>(ids->ProcessIdList[i]);
        if (pid == child.dwProcessId) foundChild = true;
        else grandchildPid = pid;
    }
    if (!foundChild || !grandchildPid) {
        TerminateJobObject(job.h, 9);
        return 29;
    }
    Handle grandchild(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                                  FALSE, grandchildPid));
    if (!grandchild.h || WaitForSingleObject(grandchild.h, 0) != WAIT_TIMEOUT) {
        TerminateJobObject(job.h, 9);
        return 30;
    }
    std::wcout << L"TREE_PIDS child=" << child.dwProcessId
               << L" grandchild=" << grandchildPid << std::endl;
    // Close the last job handle, exercising KILL_ON_JOB_CLOSE (not TerminateJobObject).
    CloseHandle(job.h);
    job.h = nullptr;
    if (WaitForSingleObject(cp.h, 5000) != WAIT_OBJECT_0) return 26;
    if (WaitForSingleObject(grandchild.h, 5000) != WAIT_OBJECT_0) return 31;
    std::wcout << L"TREE_SMOKE_FULL_PASS: child and grandchild handles signaled after job close\n";
    return 0;
}
