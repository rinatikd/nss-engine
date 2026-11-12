// Windows-only lab preflight for a future Codex Job Object broker.
// Does not launch processes, load credentials, alter services, or grant permissions.
// Build: cl /nologo /std:c++17 /EHsc /W4 /WX codex-executable-preflight.cpp
#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cwctype>
#include <iostream>
#include <string>
#include <vector>

static bool absoluteLocal(const std::wstring& p) {
    if (p.size() < 4 || !iswalpha(p[0]) || p[1] != L':' ||
        p[2] != L'\\' || p[3] == L'\\') return false;
    for (wchar_t c : p) if (c < 32 || c == L'"' || c == L'|' || c == L'?' || c == L'*') return false;
    return p.find(L':', 2) == std::wstring::npos;
}
static bool noReparseComponents(const std::wstring& path) {
    std::wstring part = path.substr(0, 3);
    for (size_t i = 3; i <= path.size(); ++i) {
        if (i != path.size() && path[i] != L'\\') continue;
        if (i == 3) continue;
        part = path.substr(0, i);
        DWORD flags = GetFileAttributesW(part.c_str());
        if (flags == INVALID_FILE_ATTRIBUTES || (flags & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    }
    return true;
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || !absoluteLocal(argv[1])) {
        std::wcerr << L"CODEX_PREFLIGHT_INVALID_PATH\n";
        return 20;
    }
    std::wstring path(argv[1]);
    std::wstring lower = path;
    for (auto& c : lower) c = static_cast<wchar_t>(towlower(c));
    const size_t slash = lower.find_last_of(L'\\');
    if (slash == std::wstring::npos || lower.substr(slash + 1) != L"codex.exe") {
        std::wcerr << L"CODEX_PREFLIGHT_NAME_DENIED\n";
        return 21;
    }
    if (!noReparseComponents(path)) {
        std::wcerr << L"CODEX_PREFLIGHT_REPARSE_OR_MISSING\n";
        return 22;
    }
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        std::wcerr << L"CODEX_PREFLIGHT_OPEN_DENIED\n";
        return 23;
    }
    BY_HANDLE_FILE_INFORMATION info{};
    const bool valid = GetFileInformationByHandle(file, &info) &&
                       !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
                       !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
    CloseHandle(file);
    if (!valid) {
        std::wcerr << L"CODEX_PREFLIGHT_NOT_REGULAR_FILE\n";
        return 24;
    }
    std::wcout << L"CODEX_PREFLIGHT_PATH_OK\n";
    std::wcout << L"CODEX_PREFLIGHT_ATTESTED: NO\n";
    std::wcout << L"CODEX_EXECUTION: DISABLED\n";
    return 0;
}
