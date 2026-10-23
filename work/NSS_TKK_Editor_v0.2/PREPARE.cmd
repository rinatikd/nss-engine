@echo off
cd /d "%~dp0"
runtime\python.exe -E -s -X utf8 scripts\prepare_loader.py
exit /b %errorlevel%
