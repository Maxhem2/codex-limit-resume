@echo off
title Codex Queue - Install or Update
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1" -Action Install
if errorlevel 1 echo Setup did not finish. Read the error above.
pause
