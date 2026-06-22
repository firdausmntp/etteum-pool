@echo off
title Create Etteum Desktop Shortcut
cd /d "%~dp0"
set "PROJECT_DIR=%~dp0"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "DESKTOP=%USERPROFILE%\Desktop"
set "SHORTCUT=%DESKTOP%\Etteum Pool.lnk"
set "VBS_LAUNCHER=%PROJECT_DIR%\Start Etteum (Silent).vbs"

echo Creating desktop shortcut...

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut('%SHORTCUT%');" ^
  "$sc.TargetPath = 'wscript.exe';" ^
  "$sc.Arguments = '\"%VBS_LAUNCHER%\"';" ^
  "$sc.WorkingDirectory = '%PROJECT_DIR%';" ^
  "$sc.Description = 'Start Etteum Pool Server';" ^
  "$sc.IconLocation = '%SystemRoot%\System32\imageres.dll,109';" ^
  "$sc.Save()"

if exist "%SHORTCUT%" (
    echo.
    echo  [OK] Shortcut created on Desktop: "Etteum Pool"
    echo  Double-click it to start the server.
) else (
    echo  [ERROR] Failed to create shortcut.
)
echo.
pause
