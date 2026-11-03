@echo off
title ChatGPT Fastlane
rem Start the ChatGPT Store app with the Speed controls (patched in memory; nothing is installed or copied).
rem If it already runs that way, it comes to the front. If ChatGPT runs normally, a message says so: quit it
rem (tray icon too) and try again. Everything printed is also in build\launch.log.
cd /d "%~dp0"
node "%~dp0patch-codex-speed.mjs" --launch --gui
if errorlevel 1 (
  echo.
  echo Launch failed. See the messages above, build\launch.log and README.md.
  pause
)
