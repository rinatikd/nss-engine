// Windows Job Object second-level descendant proof. Self-only, no Codex or production.
// Build: cl /nologo /std:c++17 /EHsc /W4 /WX job-object-tree-smoke.cpp
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <string>
#include <vector>
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
    const bool crashController = argc == 2 && std::wstring(argv[1]) == L"--crash-controller";
    if (argc != 2 || (!crashController && std::wstring(argv[1]) != L"--selftest")) return 2;
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
    // Console hosts may be assigned to the same job. Select the intended
    // descendants by their own executable image, not by total job count.
    // Hold process handles before closing the job to avoid PID-reuse races.
    Handle grandchild;
    DWORD grandchildPid = 0;
    DWORD observedMembers = 0;
    const ULONGLONG deadline = GetTickCount64() + 5000;
    while (GetTickCount64() < deadline && !grandchild.h) {
        BYTE buffer[sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 64]{};
        DWORD needed = 0;
        if (!QueryInformationJobObject(job.h, JobObjectBasicProcessIdList,
                                       buffer, sizeof(buffer), &needed)) {
            TerminateJobObject(job.h, 9);
            return 27;
        }
        const auto* ids = reinterpret_cast<const JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer);
        observedMembers = ids->NumberOfProcessIdsInList;
        for (DWORD i = 0; i < ids->NumberOfProcessIdsInList; ++i) {
            const DWORD pid = static_cast<DWORD>(ids->ProcessIdList[i]);
            if (pid == child.dwProcessId) continue;
            Handle candidate(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                                         FALSE, pid));
            if (!candidate.h) continue;
            wchar_t image[MAX_PATH]{};
            DWORD length = MAX_PATH;
            if (!QueryFullProcessImageNameW(candidate.h, 0, image, &length)) continue;
            if (_wcsicmp(image, exe) != 0) continue;
            if (WaitForSingleObject(candidate.h, 0) != WAIT_TIMEOUT) continue;
            grandchild.h = candidate.h;
            candidate.h = nullptr;
            grandchildPid = pid;
            break;
        }
        if (!grandchild.h) Sleep(25);
    }
    if (!grandchild.h || !grandchildPid) {
        std::wcerr << L"GRANDCHILD_NOT_FOUND members=" << observedMembers << L"\n";
        TerminateJobObject(job.h, 9);
        return 25;
    }
    if (WaitForSingleObject(cp.h, 0) != WAIT_TIMEOUT) {
        TerminateJobObject(job.h, 9);
        return 29;
    }
    // Capture every current job member, including conhost.exe, before job close.
    // A process handle is stronger evidence than checking a reusable PID later.
    Sleep(100);
    BYTE allBuffer[sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 64]{};
    DWORD allNeeded = 0;
    if (!QueryInformationJobObject(job.h, JobObjectBasicProcessIdList,
                                   allBuffer, sizeof(allBuffer), &allNeeded)) {
        TerminateJobObject(job.h, 9);
        return 32;
    }
    const auto* all = reinterpret_cast<const JOBOBJECT_BASIC_PROCESS_ID_LIST*>(allBuffer);
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(job.h, JobObjectBasicAccountingInformation,
                                   &accounting, sizeof(accounting), nullptr) ||
        all->NumberOfProcessIdsInList != accounting.ActiveProcesses ||
        accounting.ActiveProcesses < 2) {
        TerminateJobObject(job.h, 9);
        return 33;
    }
    std::vector<HANDLE> members;
    bool sawChild = false;
    bool sawGrandchild = false;
    for (DWORD i = 0; i < all->NumberOfProcessIdsInList; ++i) {
        const DWORD pid = static_cast<DWORD>(all->ProcessIdList[i]);
        HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
        if (!h || WaitForSingleObject(h, 0) != WAIT_TIMEOUT) {
            if (h) CloseHandle(h);
            for (HANDLE old : members) CloseHandle(old);
            TerminateJobObject(job.h, 9);
            return 34;
        }
        members.push_back(h);
        if (pid == child.dwProcessId) sawChild = true;
        if (pid == grandchildPid) sawGrandchild = true;
    }
    if (!sawChild || !sawGrandchild) {
        for (HANDLE h : members) CloseHandle(h);
        TerminateJobObject(job.h, 9);
        return 35;
    }
    if (crashController) {
        // External Windows runner retains process handles, kills this controller,
        // and checks every captured member. This process never self-releases job.
        for (DWORD i = 0; i < all->NumberOfProcessIdsInList; ++i) {
            std::wcout << L"CRASH_MEMBER_PID=" << static_cast<DWORD>(all->ProcessIdList[i]) << std::endl;
        }
        std::wcout << L"CRASH_CHILD_PID=" << child.dwProcessId << std::endl;
        std::wcout << L"CRASH_GRANDCHILD_PID=" << grandchildPid << std::endl;
        std::wcout << L"CRASH_CONTROLLER_READY" << std::endl;
        Sleep(30000);
        return 37; // Unexpected: test runner should terminate controller first.
    }
    std::wcout << L"JOB_MEMBERS_CAPTURED count=" << members.size() << std::endl;
    std::wcout << L"TREE_PIDS child=" << child.dwProcessId
               << L" grandchild=" << grandchildPid
               << L" jobMembers=" << observedMembers << std::endl;
    // Close the last job handle, exercising KILL_ON_JOB_CLOSE (not TerminateJobObject).
    CloseHandle(job.h);
    job.h = nullptr;
    if (WaitForSingleObject(cp.h, 5000) != WAIT_OBJECT_0) return 26;
    if (WaitForSingleObject(grandchild.h, 5000) != WAIT_OBJECT_0) return 31;
    for (HANDLE h : members) {
        if (WaitForSingleObject(h, 5000) != WAIT_OBJECT_0) {
            for (HANDLE held : members) CloseHandle(held);
            return 36;
        }
    }
    for (HANDLE h : members) CloseHandle(h);
    std::wcout << L"TREE_SMOKE_FULL_PASS: all captured job member handles signaled after job close\n";
    return 0;
}
