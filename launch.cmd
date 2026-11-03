@echo off
title Codex Fastlane
rem 2. Start the patched copy. Builds it first if the installed version is not built yet (a few minutes).
rem    If the copy is already running, its window is brought to the front. If the Store app is running,
rem    a message says so: quit it (tray icon too) and try again. Everything printed is also in build\launch.log.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --full-copy --if-needed --launch --gui
if errorlevel 1 (
  echo.
  echo Build or launch failed. See the messages above, build\launch.log and README.md.
  pause
)
