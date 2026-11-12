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
    std::wcout << L"TREE_PIDS child=" << child.dwProcessId
               << L" grandchild=" << grandchildPid
               << L" jobMembers=" << observedMembers << std::endl;
    // Close the last job handle, exercising KILL_ON_JOB_CLOSE (not TerminateJobObject).
    CloseHandle(job.h);
    job.h = nullptr;
    if (WaitForSingleObject(cp.h, 5000) != WAIT_OBJECT_0) return 26;
    if (WaitForSingleObject(grandchild.h, 5000) != WAIT_OBJECT_0) return 31;
    std::wcout << L"TREE_SMOKE_FULL_PASS: child and grandchild handles signaled after job close\n";
    return 0;
}
