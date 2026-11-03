@echo off
rem Delete the patched copies Fastlane V0 left in build\ (about 2 GB each). Keeps anything running.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --status
echo.
choice /M "Delete the leftover copies listed above"
if errorlevel 2 goto :eof
node "%~dp0patch-codex-speed.mjs" --cleanup
echo.
pause
