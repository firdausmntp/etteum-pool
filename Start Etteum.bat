@echo off
chcp 65001 >nul
title Proxy Pool
cd /d "%~dp0"

:: Resolve bun.exe
set "BUN_EXE="
if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"
if "%BUN_EXE%"=="" for /f "delims=" %%i in ('where bun 2^>nul') do set "BUN_EXE=%%i" & goto :found_bun
:found_bun
if "%BUN_EXE%"=="" (
    echo [ERROR] bun not found. Run install.ps1 first.
    pause
    exit /b 1
)

echo.
echo  ==============================
echo   Starting...
echo  ==============================
echo.

:: --- Cek dulu: ada yang jalan di port 1930? Kalau ada, stop dulu ---
set "PORT_IN_USE="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :1930 ^| findstr LISTENING 2^>nul') do set "PORT_IN_USE=%%a"

if defined PORT_IN_USE (
    echo  [!] Port 1930 is in use by PID %PORT_IN_USE%. Stopping...
    taskkill /PID %PORT_IN_USE% /F >nul 2>&1
    timeout /t 2 /nobreak >nul
    echo  [OK] Stopped.
    echo.
)

:: Start server (window stays open so you can see logs)
echo  Starting server... (close this window to stop)
echo.
"%BUN_EXE%" scripts/production.ts --skip-build

pause
