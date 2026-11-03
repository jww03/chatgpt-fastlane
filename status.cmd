@echo off
rem Show the installed version, the builds in build\ and what is running.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --status
echo.
pause
