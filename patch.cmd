@echo off
rem 1. Build the patched copy of the installed Codex version into build\<version>\app (about 2 GB).
rem    Does nothing if that version is already built and verified. Does not start anything.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --full-copy --if-needed
echo.
pause
