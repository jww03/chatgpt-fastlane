@echo off
rem Show the installed version, what is running, whether ChatGPT is patched, and V0 leftovers in build\.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --status
echo.
pause
