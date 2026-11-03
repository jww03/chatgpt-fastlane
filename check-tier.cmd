@echo off
rem Print the service tier the engine used for each turn in the last 3 hours (from ~/.codex/logs_2.sqlite).
cd /d "%~dp0"
node "%~dp0check-tier.mjs" 3
echo.
pause
