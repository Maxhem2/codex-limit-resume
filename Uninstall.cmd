@echo off
title Codex Queue - Uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1" -Action Uninstall
if errorlevel 1 echo Uninstall did not finish. Read the error above.
pause
