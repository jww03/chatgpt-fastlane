@echo off
rem Create or refresh the Start-menu entry "ChatGPT Fastlane" (icon + app id). Pin it to the taskbar by hand once.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --shortcut
echo.
pause
