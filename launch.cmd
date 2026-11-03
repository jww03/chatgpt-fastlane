@echo off
title Codex Fastlane
rem 2. Start the patched copy. Builds it first if the installed version is not built yet.
rem    Quit the Store app before running this (tray icon too): both use the same profile.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --full-copy --if-needed --launch
if errorlevel 1 (
  echo.
  echo Build or launch failed. See the messages above and README.md.
  pause
)
