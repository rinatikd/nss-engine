@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  python web_app.py --open
) else (
  py -3 web_app.py --open
)
if errorlevel 1 pause
