@echo off
cd /d "%~dp0"
if not exist evidence mkdir evidence
runtime\python.exe -E -s -X utf8 scripts\check.py > evidence\tests.log 2>&1
set "nss_check_exit=%errorlevel%"
type evidence\tests.log
exit /b %nss_check_exit%
