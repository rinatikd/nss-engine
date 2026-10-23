@echo off
cd /d "%~dp0"
call CHECK.cmd
if errorlevel 1 exit /b 1
dotnet tests\worker\WorkerContractTests.dll "%~dp0."
exit /b %errorlevel%
