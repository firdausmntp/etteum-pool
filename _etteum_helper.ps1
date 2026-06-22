param(
    [string]$Action,
    [string]$ProjectDir,
    [string]$PidFile,
    [string]$EnvFile,
    [string]$TunnelPid,
    [int]$Watch,
    [string]$LogArg,
    [string]$NewApiPort,
    [string]$NewDashPort
)

function genv($k, $d) {
    if (!(Test-Path $EnvFile)) { return $d }
    $l = Select-String -Path $EnvFile -Pattern "^$k=" -EA 0 | Select-Object -First 1
    if ($l) { return ($l.Line -replace "^$k=", '').Trim('"').Trim("'") }
    return $d
}

function inuse([int]$p) {
    try { $null = Get-NetTCPConnection -LocalPort $p -State Listen -EA Stop; return $true }
    catch { return $false }
}

function killport([int]$p) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue
        foreach ($conn in $conns) {
            $targetPid = $conn.OwningProcess
            if ($targetPid -and $targetPid -ne 0) {
                Write-Host "Killing process $targetPid listening on port $p..." -ForegroundColor Gray
                Stop-Process -Id $targetPid -Force -EA SilentlyContinue
            }
        }
    } catch {}
}

switch ($Action) {

    'start' {
        $ap = [int](genv 'PORT' '1930')
        $dp = [int](genv 'DASHBOARD_PORT' '1931')

        if (inuse $ap) { Write-Host "Port $ap already in use. Run: etteum stop" -ForegroundColor Red; exit 1 }
        if (inuse $dp) { Write-Host "Port $dp already in use. Run: etteum stop" -ForegroundColor Red; exit 1 }

        if ($Watch -eq 1) { Write-Host 'Starting Etteum in DEV MODE (hot-reload)...' -ForegroundColor Yellow }
        else { Write-Host 'Starting Etteum...' }

        $bun = (Get-Command bun -EA 0).Source
        if (!$bun) { $bun = "$env:USERPROFILE\.bun\bin\bun.exe" }

        $bunArgs = @('scripts/production.ts', '--skip-build')
        if ($Watch -eq 1) { $bunArgs += '--watch' }

        $logFile = $PidFile.Replace('.etteum.pid', '.etteum.log')
        $errFile = $PidFile.Replace('.etteum.pid', '.etteum.err')

        # Ensure log files exist before starting (so tail window doesn't error)
        New-Item -Path $logFile -ItemType File -Force | Out-Null
        New-Item -Path $errFile -ItemType File -Force | Out-Null

        # Start bun: hidden window + redirect to log files (no blank window)
        $proc = Start-Process -FilePath $bun -ArgumentList $bunArgs -WorkingDirectory $ProjectDir -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $errFile -WindowStyle Hidden
        $proc.Id | Out-File -FilePath $PidFile -Encoding ascii

        Write-Host 'Waiting for server...' -ForegroundColor DarkGray
        $ok = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep 1
            try { $null = Get-NetTCPConnection -LocalPort $ap -State Listen -EA Stop; $ok = $true; break }
            catch { }
        }

        if ($ok) {
            if ($Watch -eq 1) {
                Write-Host "Etteum started in DEV MODE (PID $($proc.Id))" -ForegroundColor Green
                # Open a live log tail window so user can see streaming output
                Start-Process powershell -ArgumentList '-NoProfile', '-Command', "Write-Host 'Etteum DEV MODE - Live Logs (Ctrl+C to stop tailing)' -ForegroundColor Cyan; Write-Host ''; Get-Content '$logFile' -Wait -Tail 50"
            } else {
                Write-Host "Etteum started (PID $($proc.Id))" -ForegroundColor Green
            }
            Write-Host "  Backend:   http://localhost:$ap"
            Write-Host "  Dashboard: http://localhost:$dp"
            Write-Host '  Logs:      etteum logs'

            # Check if tunnel is ACTUALLY running (not just stale PID file)
            $tunnelRunning = $false
            if (Test-Path $TunnelPid) {
                $tid = (Get-Content $TunnelPid -EA 0).Trim()
                if ($tid) {
                    try { $null = Get-Process -Id $tid -EA Stop; $tunnelRunning = $true }
                    catch { Remove-Item $TunnelPid -EA 0 }  # stale, clean up
                } else { Remove-Item $TunnelPid -EA 0 }
            }

            if (!$tunnelRunning) {
                $cf = (Get-Command cloudflared -EA 0).Source
                # If cloudflared resolves to a .ps1 wrapper (npm global), find the real .exe
                if ($cf -and $cf -match '\.ps1$') {
                    $cfExe = Join-Path (Split-Path $cf -Parent) "node_modules\cloudflared\bin\cloudflared.exe"
                    if (Test-Path $cfExe) { $cf = $cfExe }
                    else { $cf = $null }  # can't use .ps1 with Start-Process
                }
                if ($cf) {
                    try {
                        $ta = Start-Process -FilePath $cf -ArgumentList @('tunnel', 'run', 'etteum-pool') -WorkingDirectory $ProjectDir -PassThru -RedirectStandardOutput "$ProjectDir\.tunnel.log" -RedirectStandardError "$ProjectDir\.tunnel.err" -WindowStyle Hidden
                        $ta.Id | Out-File $TunnelPid -Encoding ascii
                        Write-Host "  Tunnel:    started (PID $($ta.Id))" -ForegroundColor Cyan
                    } catch { Write-Host "  Tunnel:    failed to start - $($_.Exception.Message)" -ForegroundColor Yellow }
                } else { Write-Host '  Tunnel:    cloudflared not found, skipping' -ForegroundColor Yellow }
            } else { Write-Host '  Tunnel:    already running' -ForegroundColor DarkGray }
        } else {
            Remove-Item $PidFile -EA 0
            Write-Host 'Server did not start in time. Check: etteum logs' -ForegroundColor Red
            exit 1
        }
    }

    'stop' {
        Write-Host 'Stopping Etteum...'
        $ap = [int](genv 'PORT' '1930')
        $dp = [int](genv 'DASHBOARD_PORT' '1931')
        killport $ap
        killport $dp

        Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" -EA 0 |
            Where-Object { $_.CommandLine -match 'scripts[\\/](production|start|serve-dashboard)\.ts|src[\\/]index\.ts|vite' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA 0 }
        Remove-Item $PidFile -EA 0
        Write-Host 'Etteum stopped' -ForegroundColor Green
        if (Test-Path $TunnelPid) {
            $tid = (Get-Content $TunnelPid -EA 0).Trim()
            if ($tid) { try { Stop-Process -Id $tid -Force -EA 0 } catch {} }
            Get-Process cloudflared -EA 0 | ForEach-Object { Stop-Process -Id $_.Id -Force -EA 0 }
            Remove-Item $TunnelPid -EA 0
            Write-Host 'Tunnel stopped' -ForegroundColor Green
        }
    }

    'status' {
        $running = $false; $procId = ''
        if (Test-Path $PidFile) {
            $procId = (Get-Content $PidFile -EA 0).Trim()
            if ($procId) { try { $null = Get-Process -Id $procId -EA Stop; $running = $true } catch { Remove-Item $PidFile -EA 0 } }
        }
        if ($running) {
            Write-Host "Etteum is RUNNING (PID $procId)" -ForegroundColor Green
            Write-Host "  Backend:   http://localhost:$(genv 'PORT' '1930')"
            Write-Host "  Dashboard: http://localhost:$(genv 'DASHBOARD_PORT' '1931')"
        } else { Write-Host 'Etteum is NOT running' -ForegroundColor Yellow }

        $trun = $false; $tid = ''
        if (Test-Path $TunnelPid) {
            $tid = (Get-Content $TunnelPid -EA 0).Trim()
            if ($tid) { try { $null = Get-Process -Id $tid -EA Stop; $trun = $true } catch { Remove-Item $TunnelPid -EA 0 } }
        }
        if ($trun) { Write-Host "  Tunnel:    RUNNING (PID $tid)" -ForegroundColor Cyan }
        else { Write-Host '  Tunnel:    not running' -ForegroundColor DarkGray }
    }

    'logs' {
        $lf = $PidFile.Replace('.etteum.pid', '.etteum.log')
        if (!(Test-Path $lf)) { Write-Host "No log file at $lf"; exit 0 }
        if ($LogArg -eq '-f' -or $LogArg -eq '') { Get-Content $lf -Wait -Tail 50 }
        else { Get-Content $lf -Tail ([int]$LogArg) }
    }

    'port' {
        $newApi = $NewApiPort
        $newDash = $NewDashPort
        if (!$newApi -or !$newDash) {
            Write-Host "Current  API port: $(genv 'PORT' '1930')"
            Write-Host "Current Dash port: $(genv 'DASHBOARD_PORT' '1931')"
            Write-Host 'Usage: etteum port <api_port> <dash_port>'
            exit 0
        }
        if (!(Test-Path $EnvFile)) { '' | Out-File $EnvFile -Encoding utf8 }
        $c = Get-Content $EnvFile
        if ($c -match '^PORT=') { $c = $c -replace '^PORT=.*', "PORT=$newApi" } else { $c += "PORT=$newApi" }
        if ($c -match '^DASHBOARD_PORT=') { $c = $c -replace '^DASHBOARD_PORT=.*', "DASHBOARD_PORT=$newDash" } else { $c += "DASHBOARD_PORT=$newDash" }
        $c | Set-Content $EnvFile
        Write-Host "Ports updated: API=$newApi  Dashboard=$newDash" -ForegroundColor Green
    }
}
