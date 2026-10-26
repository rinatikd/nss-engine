// Synthetic negative-probe worker only. It performs no model/API calls.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>
#include <cstdio>
#include <string>
#include <vector>

#if __has_include("worker_test_pins.h")
#include "worker_test_pins.h"
#endif

#pragma comment(lib, "ws2_32.lib")

#ifndef CB_V12_LOOPBACK_PORT
#define CB_V12_LOOPBACK_PORT 0
#endif
#ifndef CB_V12_SYNTHETIC_CREDENTIAL_PATH
#define CB_V12_SYNTHETIC_CREDENTIAL_PATH L""
#endif

static bool Missing(const wchar_t* name) {
  SetLastError(ERROR_SUCCESS);
  DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  return n == 0 && GetLastError() == ERROR_ENVVAR_NOT_FOUND;
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && wcscmp(argv[1], L"--child") == 0) return 77;
  if (argc != 2 || wcscmp(argv[1], L"--synthetic-probe") != 0) return 2;

  bool ok = Missing(L"PATH") && Missing(L"USERPROFILE") && Missing(L"CODEX_HOME") &&
            Missing(L"OPENAI_API_KEY") && Missing(L"GH_TOKEN");
  wchar_t workspace[32768]{};
  DWORD workspaceLen = GetEnvironmentVariableW(L"CB_WORKSPACE", workspace, static_cast<DWORD>(std::size(workspace)));
  if (!workspaceLen || workspaceLen >= std::size(workspace)) ok = false;
  else {
    HANDLE marker = CreateFileW(L"worker-marker.txt", GENERIC_WRITE, 0, nullptr, CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL, nullptr);
    if (marker == INVALID_HANDLE_VALUE) ok = false;
    else { const char value[] = "synthetic-only"; DWORD written = 0; ok = ok && WriteFile(marker, value, sizeof(value), &written, nullptr) && written == sizeof(value); CloseHandle(marker); }
  }

  if (*CB_V12_SYNTHETIC_CREDENTIAL_PATH) {
    HANDLE secret = CreateFileW(CB_V12_SYNTHETIC_CREDENTIAL_PATH, GENERIC_READ, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (secret != INVALID_HANDLE_VALUE) { ok = false; CloseHandle(secret); }
    else if (GetLastError() != ERROR_ACCESS_DENIED) ok = false;
  } else {
    // Missing fixture pin is not reported as a successful access-denial test.
    ok = false;
  }

  if (CB_V12_LOOPBACK_PORT > 0 && CB_V12_LOOPBACK_PORT <= 65535) {
    WSADATA data{};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) ok = false;
    else {
      SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
      sockaddr_in target{}; target.sin_family = AF_INET; target.sin_port = htons(CB_V12_LOOPBACK_PORT);
      InetPtonW(AF_INET, L"127.0.0.1", &target.sin_addr);
      const int connected = (s == INVALID_SOCKET) ? SOCKET_ERROR : connect(s, reinterpret_cast<sockaddr*>(&target), sizeof(target));
      // The VM observer must run a listener on this exact port. Any successful
      // connection is a failure; a no-listener result is inconclusive.
      const int connectError = WSAGetLastError();
      if (connected == 0) ok = false;
      else if (connectError != WSAEACCES && connectError != WSAETIMEDOUT) ok = false;
      if (s != INVALID_SOCKET) closesocket(s);
      WSACleanup();
    }
  } else ok = false;

  wchar_t self[32768]{};
  DWORD selfLen = GetModuleFileNameW(nullptr, self, static_cast<DWORD>(std::size(self)));
  if (!selfLen || selfLen >= std::size(self)) ok = false;
  else {
    std::wstring cmd = L"\"" + std::wstring(self) + L"\" --child";
    std::vector<wchar_t> mutableCmd(cmd.begin(), cmd.end()); mutableCmd.push_back(L'\0');
    STARTUPINFOW si{}; si.cb = sizeof(si); PROCESS_INFORMATION pi{};
    if (CreateProcessW(self, mutableCmd.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
        nullptr, nullptr, &si, &pi)) {
      ok = false;
      TerminateProcess(pi.hProcess, ERROR_PROCESS_ABORTED);
      WaitForSingleObject(pi.hProcess, 5000);
      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    }
    // Do not infer job containment from error code alone. Host-side observer
    // must verify Job membership, active-process limit, and empty descendants.
  }

  std::fwprintf(stdout, L"probe_result=%ls\n", ok ? L"EXPECTED_DENIALS_OBSERVED" : L"FAIL_OR_INCONCLUSIVE");
  return ok ? 0 : 10;
}
