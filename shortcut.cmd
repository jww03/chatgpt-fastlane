@echo off
rem Create or refresh the Start-menu entry "ChatGPT Fastlane" (runs launch.cmd, Fastlane icon). Pin it by hand once.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --shortcut
echo.
pause
