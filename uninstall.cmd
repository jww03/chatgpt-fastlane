@echo off
title Codex Fastlane - uninstall
rem Remove the patched copy: quit it, delete the Start-menu entry and the build folder (about 2 GB).
rem The Store app is untouched. ~\.codex (config, sessions) and this folder itself are kept; see README "Uninstall".
cd /d "%~dp0"
echo This quits the patched Codex copy and deletes:
echo   - the Start-menu entry "Codex Fastlane" (unpin it from the taskbar yourself if pinned)
echo   - %~dp0build\ (all patched copies and logs)
echo It keeps ~\.codex, the copy's profile in %%APPDATA%%\Codex, and this folder.
echo.
choice /M "Continue"
if errorlevel 2 goto :eof
node "%~dp0patch-codex-speed.mjs" --uninstall
echo.
pause
