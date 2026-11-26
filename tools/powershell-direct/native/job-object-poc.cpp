#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <string>
#include <vector>
#include <cstdlib>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

struct ManagedProcess {
  HANDLE job = nullptr;
  HANDLE process = nullptr;
  DWORD pid = 0;
};

static void fail(const wchar_t* op) {
  std::fwprintf(stderr, L"%ls failed: %lu\n", op, GetLastError());
  ExitProcess(2);
}

static bool start_in_job(const wchar_t* exe, const std::wstring& command,
                         const wchar_t* cwd, ManagedProcess& out) {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return false;

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    CloseHandle(job); return false;
  }

  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
  std::vector<unsigned char> storage(bytes);
  auto* attrs = reinterpret_cast<PPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attrs, 1, 0, &bytes)) {
    CloseHandle(job); return false;
  }

  HANDLE jobs[] = { job };
  if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 jobs, sizeof(jobs), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attrs); CloseHandle(job); return false;
  }

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.lpAttributeList = attrs;
  std::vector<wchar_t> mutable_command(command.begin(), command.end());
  mutable_command.push_back(L'\0');
  PROCESS_INFORMATION pi{};
  const BOOL ok = CreateProcessW(exe, mutable_command.data(), nullptr, nullptr,
    FALSE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
    nullptr, cwd, &si.StartupInfo, &pi);
  const DWORD create_error = ok ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(attrs);
  if (!ok) { CloseHandle(job); SetLastError(create_error); return false; }

  // The process is already a member of the Job before its first instruction.
  if (ResumeThread(pi.hThread) == static_cast<DWORD>(-1)) {
    const DWORD resume_error = GetLastError();
    TerminateJobObject(job, resume_error);
    WaitForSingleObject(pi.hProcess, 5000);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(job);
    SetLastError(resume_error); return false;
  }
  CloseHandle(pi.hThread);
  out.job = job; out.process = pi.hProcess; out.pid = pi.dwProcessId;
  return true;
}

static DWORD active_processes(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                  &info, sizeof(info), nullptr)) fail(L"QueryInformationJobObject");
  return info.ActiveProcesses;
}

static int child_mode(bool spawn_descendant, const wchar_t* self) {
  if (spawn_descendant) {
    std::wstring cmd = L"\"" + std::wstring(self) + L"\" --child";
    STARTUPINFOW si{}; si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(self, cmd.data(), nullptr, nullptr, FALSE, 0,
                        nullptr, nullptr, &si, &pi)) fail(L"CreateProcessW descendant");
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return 0;
  }
  Sleep(60000);
  return 0;
}


static int kill_on_close_owner(const wchar_t* self) {
  std::wstring command = L"\"" + std::wstring(self) + L"\" --child";
  ManagedProcess p{};
  if (!start_in_job(self, command, nullptr, p)) fail(L"start_in_job kill-on-close");
  std::wprintf(L"%lu\n", p.pid);
  std::fflush(stdout);
  Sleep(INFINITE);
  return 0;
}

static bool verify_kill_on_close(const wchar_t* self) {
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE read_pipe = nullptr, write_pipe = nullptr;
  if (!CreatePipe(&read_pipe, &write_pipe, &sa, 0)) fail(L"CreatePipe");
  if (!SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0)) fail(L"SetHandleInformation");

  STARTUPINFOW si{}; si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = write_pipe;
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  std::wstring command = L"\"" + std::wstring(self) + L"\" --kill-on-close-owner";
  PROCESS_INFORMATION owner{};
  if (!CreateProcessW(self, command.data(), nullptr, nullptr, TRUE, 0,
                      nullptr, nullptr, &si, &owner)) fail(L"CreateProcessW owner");
  CloseHandle(write_pipe);

  char line[64]{};
  DWORD used = 0;
  while (used < sizeof(line) - 1) {
    DWORD got = 0;
    if (!ReadFile(read_pipe, line + used, 1, &got, nullptr) || got == 0) {
      CloseHandle(read_pipe); TerminateProcess(owner.hProcess, 9);
      CloseHandle(owner.hThread); CloseHandle(owner.hProcess);
      std::fwprintf(stderr, L"FAIL: owner did not publish descendant PID\n");
      return false;
    }
    if (line[used++] == '\n') break;
  }
  CloseHandle(read_pipe);
  const DWORD descendant_pid = static_cast<DWORD>(strtoul(line, nullptr, 10));
  HANDLE descendant = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                                  FALSE, descendant_pid);
  if (!descendant) {
    TerminateProcess(owner.hProcess, 9);
    CloseHandle(owner.hThread); CloseHandle(owner.hProcess);
    std::fwprintf(stderr, L"FAIL: cannot open descendant process\n");
    return false;
  }

  if (!TerminateProcess(owner.hProcess, 0xC000013A)) fail(L"TerminateProcess owner");
  WaitForSingleObject(owner.hProcess, 5000);
  const DWORD descendant_exit = WaitForSingleObject(descendant, 5000);
  CloseHandle(descendant); CloseHandle(owner.hThread); CloseHandle(owner.hProcess);
  if (descendant_exit != WAIT_OBJECT_0) {
    std::fwprintf(stderr, L"FAIL: descendant survived owner termination; KILL_ON_JOB_CLOSE unconfirmed\n");
    return false;
  }
  std::wprintf(L"PASS: abrupt owner termination closed Job Object and terminated descendant\n");
  return true;
}


static bool verify_nested_job_assignment(const wchar_t* self) {
  HANDLE parent_job = CreateJobObjectW(nullptr, nullptr);
  if (!parent_job) fail(L"CreateJobObjectW parent");
  if (!AssignProcessToJobObject(parent_job, GetCurrentProcess())) {
    const DWORD error = GetLastError();
    CloseHandle(parent_job);
    std::fwprintf(stderr, L"FAIL: cannot place test host in parent Job Object: %lu\n", error);
    return false;
  }

  std::wstring command = L"\"" + std::wstring(self) + L"\" --spawn-descendant";
  ManagedProcess nested{};
  if (!start_in_job(self, command, nullptr, nested)) {
    const DWORD error = GetLastError();
    CloseHandle(parent_job);
    std::fwprintf(stderr, L"FAIL: child creation in nested Job Object: %lu\n", error);
    return false;
  }
  if (WaitForSingleObject(nested.process, 10000) != WAIT_OBJECT_0) {
    TerminateJobObject(nested.job, 9);
    CloseHandle(nested.process); CloseHandle(nested.job); CloseHandle(parent_job);
    std::fwprintf(stderr, L"FAIL: nested-job root did not exit\n");
    return false;
  }
  CloseHandle(nested.process);
  DWORD active = 0;
  for (int i = 0; i < 100; ++i) {
    active = active_processes(nested.job);
    if (active >= 1) break;
    Sleep(20);
  }
  if (active < 1 || !TerminateJobObject(nested.job, 0xC000013A)) {
    const DWORD error = GetLastError();
    CloseHandle(nested.job); CloseHandle(parent_job);
    std::fwprintf(stderr, L"FAIL: nested Job did not retain/terminate descendant: %lu\n", error);
    return false;
  }
  for (int i = 0; i < 100 && active_processes(nested.job) != 0; ++i) Sleep(20);
  active = active_processes(nested.job);
  CloseHandle(nested.job);
  CloseHandle(parent_job);
  if (active != 0) {
    std::fwprintf(stderr, L"FAIL: nested Job still has active processes\n");
    return false;
  }
  std::wprintf(L"PASS: process already in parent Job created nested Job; descendant contained and terminated\n");
  return true;
}


static int breakaway_probe(const wchar_t* self) {
  std::wstring command = L"\"" + std::wstring(self) + L"\" --child";
  STARTUPINFOW si{}; si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  if (CreateProcessW(self, command.data(), nullptr, nullptr, FALSE,
                     CREATE_BREAKAWAY_FROM_JOB, nullptr, nullptr, &si, &pi)) {
    CloseHandle(pi.hThread);
    TerminateProcess(pi.hProcess, 9);
    WaitForSingleObject(pi.hProcess, 5000);
    CloseHandle(pi.hProcess);
    std::fwprintf(stderr, L"FAIL: CREATE_BREAKAWAY_FROM_JOB escaped the execution Job\n");
    return 1;
  }
  const DWORD error = GetLastError();
  if (error != ERROR_ACCESS_DENIED) {
    std::fwprintf(stderr, L"FAIL: breakaway rejected with unexpected Win32 error %lu\n", error);
    return 2;
  }
  std::wprintf(L"PASS: CREATE_BREAKAWAY_FROM_JOB rejected with ERROR_ACCESS_DENIED\n");
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--breakaway-probe") == 0) return breakaway_probe(argv[0]);
  if (argc >= 2 && wcscmp(argv[1], L"--kill-on-close-owner") == 0) return kill_on_close_owner(argv[0]);
  if (argc >= 2 && wcscmp(argv[1], L"--child") == 0) return child_mode(false, argv[0]);
  if (argc >= 2 && wcscmp(argv[1], L"--spawn-descendant") == 0) return child_mode(true, argv[0]);

  wchar_t self[MAX_PATH]{};
  if (!GetModuleFileNameW(nullptr, self, MAX_PATH)) fail(L"GetModuleFileNameW");
  if (!verify_kill_on_close(self)) return 5;
  if (!verify_nested_job_assignment(self)) return 6;
  ManagedProcess breakaway{};
  const std::wstring breakaway_command = L"\"" + std::wstring(self) + L"\" --breakaway-probe";
  if (!start_in_job(self, breakaway_command, nullptr, breakaway)) fail(L"start breakaway probe");
  if (WaitForSingleObject(breakaway.process, 10000) != WAIT_OBJECT_0) { TerminateJobObject(breakaway.job, 9); return 7; }
  DWORD breakaway_exit = 99;
  if (!GetExitCodeProcess(breakaway.process, &breakaway_exit)) fail(L"GetExitCodeProcess breakaway");
  CloseHandle(breakaway.process); CloseHandle(breakaway.job);
  if (breakaway_exit != 0) return 8;
  std::wstring command = L"\"" + std::wstring(self) + L"\" --spawn-descendant";
  ManagedProcess p{};
  if (!start_in_job(self, command, nullptr, p)) fail(L"start_in_job");

  if (WaitForSingleObject(p.process, 10000) != WAIT_OBJECT_0) fail(L"wait root process");
  CloseHandle(p.process); p.process = nullptr;

  // Root exits, but its grandchild must still be accounted for by the same Job.
  DWORD active = 0;
  for (int i = 0; i < 100; ++i) {
    active = active_processes(p.job);
    if (active >= 1) break;
    Sleep(20);
  }
  if (active < 1) {
    std::fwprintf(stderr, L"FAIL: descendant not retained in Job\n");
    CloseHandle(p.job); return 3;
  }

  if (!TerminateJobObject(p.job, 0xC000013A)) fail(L"TerminateJobObject");
  for (int i = 0; i < 100; ++i) {
    active = active_processes(p.job);
    if (active == 0) break;
    Sleep(20);
  }
  if (active != 0) {
    std::fwprintf(stderr, L"FAIL: Job still has %lu active process(es)\n", active);
    CloseHandle(p.job); return 4;
  }
  CloseHandle(p.job);
  std::wprintf(L"PASS: creation-time Job assignment; descendant tracked; job termination confirmed\n");
  return 0;
}
