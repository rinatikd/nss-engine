@echo off
setlocal
if exist "%~dp0runtime\python.exe" (
  "%~dp0runtime\python.exe" -E -s -X utf8 "%~dp0scripts\build_validate_v042.py" %*
) else (
  python "%~dp0scripts\build_validate_v042.py" %*
)
exit /b %errorlevel%
