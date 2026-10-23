@echo off
setlocal
"%~dp0runtime\python.exe" -E -s -X utf8 "%~dp0scripts\autodebug_v0421.py" %*
set "NSS_RESULT=%errorlevel%"
echo.
echo NSS AutoDebug finished. See RESULT.html and the diagnostics ZIP printed above.
if "%~1"=="" pause
exit /b %NSS_RESULT%
