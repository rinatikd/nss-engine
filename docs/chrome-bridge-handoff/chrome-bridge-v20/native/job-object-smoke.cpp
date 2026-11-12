// Windows-only native containment smoke test. No Codex, no network, no MCP.
// Build with: cl /std:c++17 /EHsc /W4 job-object-smoke.cpp
// Usage: job-object-smoke.exe C:\Windows\System32\cmd.exe
// The child is created suspended and assigned to a kill-on-close Job Object
// BEFORE it is resumed. This tests basic OS primitives, not full E2E containment.
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <string>

struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};

static void fail(const wchar_t* step) {
    std::wcerr << step << L" failed, Win32=" << GetLastError() << L"\n";
}

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--child-wait") {
        Sleep(30000);
        return 0;
    }
    if (argc != 2 && !(argc == 3 && std::wstring(argv[1]) == L"--kill-on-close")) {
        std::wcerr << L"Usage: job-object-smoke.exe <absolute-local-exe>\n";
        return 2;
    }
    const bool killOnClose = argc == 3;
    const std::wstring exe(argv[killOnClose ? 2 : 1]);
    if (exe.size() < 4 || exe[1] != L':' || exe[2] != L'\\' ||
        exe.rfind(L"\\\\", 0) == 0) {
        std::wcerr << L"Absolute local executable path required\n";
        return 2;
    }

    Handle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.value) { fail(L"CreateJobObjectW"); return 3; }

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits))) {
        fail(L"SetInformationJobObject"); return 4;
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    // Test command is fixed; no user-provided command line, shell or stdin.
    // Windows CreateProcessW takes mutable command-line storage.
    std::wstring cmd = L"\"" + exe + L"\" /c exit 0";
    if (!CreateProcessW(exe.c_str(), cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW,
                        nullptr, nullptr, &si, &pi)) {
        fail(L"CreateProcessW"); return 5;
    }
    Handle process(pi.hProcess);
    Handle thread(pi.hThread);

    if (!AssignProcessToJobObject(job.value, process.value)) {
        fail(L"AssignProcessToJobObject");
        TerminateProcess(process.value, 1);
        WaitForSingleObject(process.value, 10000);
        return 6; // NEVER resume an uncontained process
    }
    if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
        fail(L"ResumeThread");
        TerminateJobObject(job.value, 1);
        WaitForSingleObject(process.value, 10000);
        return 7;
    }
    if (killOnClose) {
        // The child must still be alive; closing the last job handle kills it.
        if (WaitForSingleObject(process.value, 250) != WAIT_TIMEOUT) {
            std::wcerr << L"Child exited before kill-on-close verification\\n";
            return 12;
        }
        CloseHandle(job.value);
        job.value = nullptr;
        if (WaitForSingleObject(process.value, 10000) != WAIT_OBJECT_0) {
            std::wcerr << L"Kill-on-close did not terminate child\\n";
            return 13;
        }
        std::wcout << L"JOB_OBJECT_KILL_ON_CLOSE_OK\\n";
        return 0;
    }
    const DWORD waited = WaitForSingleObject(process.value, 10000);
    if (waited != WAIT_OBJECT_0) {
        TerminateJobObject(job.value, 1);
        fail(L"WaitForSingleObject");
        return 8;
    }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
                                   &info, sizeof(info), nullptr)) {
        fail(L"QueryInformationJobObject"); return 9;
    }
    if (info.ActiveProcesses != 0) {
        std::wcerr << L"Job still has active descendants: " << info.ActiveProcesses << L"\n";
        TerminateJobObject(job.value, 1);
        return 10;
    }
    DWORD exitCode = 0;
    if (!GetExitCodeProcess(process.value, &exitCode) || exitCode != 0) {
        std::wcerr << L"Child exit code not zero\n";
        return 11;
    }
    std::wcout << L"JOB_OBJECT_SMOKE_OK\n";
    return 0;
}
