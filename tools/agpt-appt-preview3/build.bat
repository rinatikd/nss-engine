@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoLogo -NoProfile -File "%~dp0build.ps1" -Mode Build -AcadDir "%~1"
set "AGPT_EXIT=%ERRORLEVEL%"
endlocal & exit /b %AGPT_EXIT%
