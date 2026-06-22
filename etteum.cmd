@echo off
setlocal EnableDelayedExpansion

:: =================================================================
:: etteum.cmd - Etteum Management CLI (Windows)
:: Usage: etteum [start|stop|restart|dev|status|logs|update|build|port]
:: =================================================================

:: -- Resolve PROJECT_DIR ------------------------------------------
if defined POOLPROX_HOME (
    if exist "%POOLPROX_HOME%\" (
        set "PROJECT_DIR=%POOLPROX_HOME%"
        goto :dir_ok
    )
)
if defined ETTEUM_HOME (
    if exist "%ETTEUM_HOME%\" (
        set "PROJECT_DIR=%ETTEUM_HOME%"
        goto :dir_ok
    )
)
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

:dir_ok
set "PID_FILE=%PROJECT_DIR%\.etteum.pid"
set "LOG_FILE=%PROJECT_DIR%\.etteum.log"
set "ENV_FILE=%PROJECT_DIR%\.env"
set "TUNNEL_PID=%PROJECT_DIR%\.tunnel.pid"
set "HELPER=%PROJECT_DIR%\_etteum_helper.ps1"

:: -- Route command ------------------------------------------------
set "_CMD=%~1"
if "%_CMD%"=="" set "_CMD=help"

if /i "%_CMD%"=="start"   goto :cmd_start
if /i "%_CMD%"=="stop"    goto :cmd_stop
if /i "%_CMD%"=="restart" goto :cmd_restart
if /i "%_CMD%"=="dev"     goto :cmd_dev
if /i "%_CMD%"=="status"  goto :cmd_status
if /i "%_CMD%"=="logs"    goto :cmd_logs
if /i "%_CMD%"=="update"  goto :cmd_update
if /i "%_CMD%"=="build"   goto :cmd_build
if /i "%_CMD%"=="port"    goto :cmd_port
goto :cmd_help

:: =================================================================
:cmd_start
set "_WATCH=0"
if /i "%~2"=="--watch" set "_WATCH=1"
if /i "%~2"=="--dev"   set "_WATCH=1"
if /i "%~2"=="-w"      set "_WATCH=1"
if /i "%~3"=="--watch" set "_WATCH=1"
if /i "%~3"=="--dev"   set "_WATCH=1"
if /i "%~3"=="-w"      set "_WATCH=1"
call :fn_start
goto :end

:cmd_dev
set "_WATCH=1"
call :fn_start
goto :end

:cmd_stop
call :fn_stop
goto :end

:cmd_restart
set "_WATCH=0"
if /i "%~2"=="--watch" set "_WATCH=1"
if /i "%~2"=="--dev"   set "_WATCH=1"
if /i "%~2"=="-w"      set "_WATCH=1"
call :fn_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
call :fn_start
goto :end

:cmd_status
call :fn_status
goto :end

:cmd_logs
call :fn_logs
goto :end

:cmd_update
call :fn_update
goto :end

:cmd_build
call :fn_build
goto :end

:cmd_port
call :fn_port
goto :end

:cmd_help
echo etteum - Etteum Management CLI (Windows)
echo.
echo Usage: etteum ^<command^> [flags]
echo.
echo Commands:
echo   start [--watch]   Start the server (--watch enables hot-reload)
echo   stop              Stop the server
echo   restart [--watch] Restart the server
echo   dev               Alias for: start --watch
echo   status            Show server status
echo   logs [-f ^| N]     View logs (follow or last N lines)
echo   update            Pull git, install deps, build, restart
echo   build             Rebuild dashboard and restart
echo   port [api dash]   Show or change ports
goto :end

:: =================================================================
:: fn_start
:: =================================================================
:fn_start
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action start -ProjectDir "%PROJECT_DIR%" -PidFile "%PID_FILE%" -EnvFile "%ENV_FILE%" -TunnelPid "%TUNNEL_PID%" -Watch %_WATCH%
goto :eof

:: =================================================================
:: fn_stop
:: =================================================================
:fn_stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action stop -ProjectDir "%PROJECT_DIR%" -PidFile "%PID_FILE%" -EnvFile "%ENV_FILE%" -TunnelPid "%TUNNEL_PID%"
goto :eof

:: =================================================================
:: fn_status
:: =================================================================
:fn_status
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action status -ProjectDir "%PROJECT_DIR%" -PidFile "%PID_FILE%" -EnvFile "%ENV_FILE%" -TunnelPid "%TUNNEL_PID%"
goto :eof

:: =================================================================
:: fn_logs
:: =================================================================
:fn_logs
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action logs -ProjectDir "%PROJECT_DIR%" -PidFile "%PID_FILE%" -EnvFile "%ENV_FILE%" -TunnelPid "%TUNNEL_PID%" -LogArg "%~2"
goto :eof

:: =================================================================
:: fn_update
:: =================================================================
:fn_update
echo Pulling latest changes...
cd /d "%PROJECT_DIR%"
git pull
echo Installing dependencies...
bun install
echo Building dashboard...
cd /d "%PROJECT_DIR%\dashboard"
bun run build
cd /d "%PROJECT_DIR%"
call :fn_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
call :fn_start
goto :eof

:: =================================================================
:: fn_build
:: =================================================================
:fn_build
echo Building dashboard...
cd /d "%PROJECT_DIR%\dashboard"
bun run build
cd /d "%PROJECT_DIR%"
call :fn_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
call :fn_start
goto :eof

:: =================================================================
:: fn_port
:: =================================================================
:fn_port
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action port -ProjectDir "%PROJECT_DIR%" -PidFile "%PID_FILE%" -EnvFile "%ENV_FILE%" -TunnelPid "%TUNNEL_PID%" -NewApiPort "%~2" -NewDashPort "%~3"
if "%~2"=="" goto :end
if "%~3"=="" goto :end
call :fn_stop
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
call :fn_start
goto :eof

:end
endlocal
