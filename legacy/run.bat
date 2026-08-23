@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python not found. Install it from https://python.org
    echo IMPORTANT: check "Add python.exe to PATH" during installation.
    pause
    exit /b 1
)

python app.py
if errorlevel 1 pause
