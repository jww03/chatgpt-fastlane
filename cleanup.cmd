@echo off
rem Delete builds of other versions (keeps the installed version's build and anything running).
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --status
echo.
choice /M "Delete the old builds listed above"
if errorlevel 2 goto :eof
node "%~dp0patch-codex-speed.mjs" --prune
echo.
pause
