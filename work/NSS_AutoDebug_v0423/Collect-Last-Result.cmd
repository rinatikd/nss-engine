@echo off
setlocal
"%~dp0runtime\python.exe" -E -s -X utf8 "%~dp0scripts\autodebug_v0421.py" --collect-last
set "NSS_RESULT=%errorlevel%"
echo.
pause
exit /b %NSS_RESULT%
