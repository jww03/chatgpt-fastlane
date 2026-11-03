@echo off
rem 3. Update the Store app (Microsoft Store via winget), then build and start the patched copy of the new version.
rem    If a patched copy of the old version is still running, the build happens but the start is skipped:
rem    quit the old copy and run launch.cmd. Old builds are listed; cleanup.cmd deletes them.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --store-update --full-copy --if-needed --launch
echo.
node "%~dp0patch-codex-speed.mjs" --status
echo.
pause
