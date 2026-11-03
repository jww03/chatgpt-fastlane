@echo off
rem Ask the Microsoft Store for an update of ChatGPT (winget), then start it with the Speed controls and show the status.
rem Nothing to rebuild: launch patches whatever version is installed.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --store-update --launch
echo.
node "%~dp0patch-codex-speed.mjs" --status
echo.
pause
