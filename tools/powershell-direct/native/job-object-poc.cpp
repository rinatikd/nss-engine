#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <string>
#include <vector>

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

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--child") == 0) return child_mode(false, argv[0]);
  if (argc >= 2 && wcscmp(argv[1], L"--spawn-descendant") == 0) return child_mode(true, argv[0]);

  wchar_t self[MAX_PATH]{};
  if (!GetModuleFileNameW(nullptr, self, MAX_PATH)) fail(L"GetModuleFileNameW");
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
