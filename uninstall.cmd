@echo off
title ChatGPT Fastlane - uninstall
rem Remove ChatGPT Fastlane: stop the helper, delete the Start-menu entry and build\ (logs, V0 leftovers).
rem The Store app was never changed and keeps running. ~\.codex and this folder are kept; see README "Uninstall".
cd /d "%~dp0"
echo This stops the Fastlane helper and deletes:
echo   - the Start-menu entry "ChatGPT Fastlane" (unpin it from the taskbar yourself if pinned)
echo   - %~dp0build\ (logs and any patched copies left from V0)
echo ChatGPT keeps running; from its next start it is the normal app. ~\.codex and this folder are kept.
echo.
choice /M "Continue"
if errorlevel 2 goto :eof
node "%~dp0patch-codex-speed.mjs" --uninstall
echo.
pause
