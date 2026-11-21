@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0core\launch.ps1" -Session "%~1" -Project "%~2"
