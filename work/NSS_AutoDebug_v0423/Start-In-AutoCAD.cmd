@echo off
setlocal
"%~dp0runtime\python.exe" -E -s -X utf8 "%~dp0scripts\autodebug_v0421.py" --in-host --timeout 600 %*
set "NSS_RESULT=%errorlevel%"
echo.
echo NSS in-host test finished. See RESULT.html and the diagnostics ZIP printed above.
if "%~1"=="" pause
exit /b %NSS_RESULT%
