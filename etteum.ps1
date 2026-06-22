# etteum.ps1 - Etteum management CLI (Windows)
# Usage: etteum [start|stop|restart|status|logs|update|port|build]

param(
  [Parameter(Position = 0)][string]$Command = "help",
  [Parameter(Position = 1)][string]$Arg1,
  [Parameter(Position = 2)][string]$Arg2
)

$ErrorActionPreference = "Stop"

# Auto-detect project dir: env override > script dir
if ($env:POOLPROX_HOME -and (Test-Path $env:POOLPROX_HOME)) {
  $ProjectDir = $env:POOLPROX_HOME
} else {
  $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$PidFile = Join-Path $ProjectDir ".etteum.pid"
$LogFile = Join-Path $ProjectDir ".etteum.log"
$EnvFile = Join-Path $ProjectDir ".env"
$TunnelPidFile = Join-Path $ProjectDir ".tunnel.pid"
$TunnelName = "etteum-pool"

function Get-EnvValue([string]$key, [string]$default) {
  if (-not (Test-Path $EnvFile)) { return $default }
  $line = Select-String -Path $EnvFile -Pattern "^$key=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return ($line.Line -replace "^$key=", "").Trim('"').Trim("'") }
  return $default
}

function Test-Running {
  if (-not (Test-Path $PidFile)) { return $false }
  $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
  if (-not $procId) { return $false }
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    return $true
  } catch {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    return $false
  }
}

function Test-PortInUse([int]$port) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    return [bool]$listener
  } catch { return $false }
}

function Stop-PortProcess([int]$port) {
  try {
    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
      $pId = $conn.OwningProcess
      if ($pId -and $pId -ne 0) {
        Write-Host "Stopping process $pId listening on port $port..." -ForegroundColor Gray
        Stop-Process -Id $pId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
}

function Test-TunnelRunning {
  if (-not (Test-Path $TunnelPidFile)) { return $false }
  $procId = Get-Content $TunnelPidFile -ErrorAction SilentlyContinue
  if (-not $procId) { return $false }
  try {
    Get-Process -Id $procId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    Remove-Item $TunnelPidFile -ErrorAction SilentlyContinue
    return $false
  }
}

function Start-Tunnel {
  if (Test-TunnelRunning) {
    Write-Host "  Tunnel:    already running" -ForegroundColor DarkGray
    return
  }
  $cfExe = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cfExe) {
    Write-Host "  Tunnel:    cloudflared not found, skipping" -ForegroundColor Yellow
    return
  }
  try {
    if ($cfExe -match '\.(cmd|ps1)$') {
      $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList @("/c", $cfExe, "tunnel", "run", $TunnelName) `
        -WorkingDirectory $ProjectDir -PassThru `
        -RedirectStandardOutput (Join-Path $ProjectDir ".tunnel.log") `
        -RedirectStandardError  (Join-Path $ProjectDir ".tunnel.err")
    } else {
      $proc = Start-Process -FilePath $cfExe `
        -ArgumentList @("tunnel", "run", $TunnelName) `
        -WorkingDirectory $ProjectDir -PassThru `
        -RedirectStandardOutput (Join-Path $ProjectDir ".tunnel.log") `
        -RedirectStandardError  (Join-Path $ProjectDir ".tunnel.err")
    }
    $proc.Id | Out-File -FilePath $TunnelPidFile -Encoding ascii
    Write-Host "  Tunnel:    https://pool.bytehub.my.id (PID $($proc.Id))" -ForegroundColor Cyan
  } catch {
    Write-Host "  Tunnel:    failed to start ($_), skipping" -ForegroundColor Yellow
  }
}

function Stop-Tunnel {
  if (-not (Test-TunnelRunning)) { return }
  $procId = Get-Content $TunnelPidFile -ErrorAction SilentlyContinue
  if ($procId) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  # Kill any stray cloudflared processes for this tunnel
  Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $TunnelPidFile -ErrorAction SilentlyContinue
  Write-Host "Tunnel stopped"
}

function Invoke-Start {
  param([bool]$Watch = $false)

  $apiPort = [int](Get-EnvValue "PORT" "1930")
  $dashPort = [int](Get-EnvValue "DASHBOARD_PORT" "1931")

  if (Test-PortInUse $apiPort) {
    Write-Host "Port $apiPort in use — stopping existing instance..." -ForegroundColor Yellow
    Invoke-Stop
    Start-Sleep -Seconds 1
  } elseif (Test-PortInUse $dashPort) {
    Write-Host "Port $dashPort in use — stopping existing instance..." -ForegroundColor Yellow
    Invoke-Stop
    Start-Sleep -Seconds 1
  }

  if ($Watch) {
    Write-Host "Starting Etteum in DEV MODE (hot-reload)..." -ForegroundColor Yellow
  } else {
    Write-Host "Starting Etteum..."
  }
  $BunExe = (Get-Command bun -ErrorAction SilentlyContinue).Source
  if (-not $BunExe) { $BunExe = "$env:USERPROFILE\.bun\bin\bun.exe" }
  # Start bun directly - NO -RedirectStandardOutput (it breaks Bun.spawn on Windows)
  $startArgs = @("scripts/production.ts", "--skip-build")
  if ($Watch) { $startArgs += "--watch" }
  $proc = Start-Process -FilePath $BunExe -ArgumentList $startArgs `
    -WorkingDirectory $ProjectDir -PassThru
  $proc.Id | Out-File -FilePath $PidFile -Encoding ascii

  # Wait for server to be ready (retry up to 15 seconds; dev mode is slower)
  $maxWait = if ($Watch) { 30 } else { 15 }
  $started = $false
  for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 1
    try {
      $listener = Get-NetTCPConnection -LocalPort $apiPort -State Listen -ErrorAction Stop
      $started = $true
      break
    } catch { continue }
  }

  if ($started) {
    if ($Watch) {
      Write-Host "Etteum started in DEV MODE (PID $($proc.Id))" -ForegroundColor Green
    } else {
      Write-Host "Etteum started (PID $($proc.Id))" -ForegroundColor Green
    }
    Write-Host "  Backend:   http://localhost:$apiPort"
    Write-Host "  Dashboard: http://localhost:$dashPort"
    Write-Host "  Logs:      etteum logs"
    Start-Tunnel
  } else {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Failed to start. Try: bun scripts/production.ts --skip-build" -ForegroundColor Red
  }
}

function Invoke-Stop {
  Write-Host "Stopping Etteum..."
  $apiPort = [int](Get-EnvValue "PORT" "1930")
  $dashPort = [int](Get-EnvValue "DASHBOARD_PORT" "1931")
  Stop-PortProcess $apiPort
  Stop-PortProcess $dashPort

  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "scripts[\\/](production|start|serve-dashboard)\.ts|src[\\/]index\.ts|vite" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "Etteum stopped"
  Stop-Tunnel
}

function Invoke-Status {
  if (Test-Running) {
    $procId = Get-Content $PidFile
    Write-Host "Etteum is running (PID $procId)" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$(Get-EnvValue 'PORT' '1930')"
    Write-Host "  Dashboard: http://localhost:$(Get-EnvValue 'DASHBOARD_PORT' '1931')"
  } else {
    Write-Host "Etteum is not running" -ForegroundColor Yellow
  }
  if (Test-TunnelRunning) {
    $tPid = Get-Content $TunnelPidFile -ErrorAction SilentlyContinue
    Write-Host "  Tunnel:    https://pool.bytehub.my.id (PID $tPid)" -ForegroundColor Cyan
  } else {
    Write-Host "  Tunnel:    not running" -ForegroundColor DarkGray
  }
}

function Invoke-Logs([string]$tailArg) {
  if (-not (Test-Path $LogFile)) {
    Write-Host "No logs yet at $LogFile"
    return
  }
  if ($tailArg -eq "-f" -or -not $tailArg) {
    Get-Content $LogFile -Wait -Tail 50
  } else {
    Get-Content $LogFile -Tail ([int]$tailArg)
  }
}

function Invoke-Update {
  Write-Host "Pulling latest..."
  Push-Location $ProjectDir
  try {
    git pull
    Write-Host "Installing dependencies..."
    bun install
    Write-Host "Building dashboard..."
    Push-Location (Join-Path $ProjectDir "dashboard")
    try { bun run build } finally { Pop-Location }
    Write-Host "Restarting..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  } finally { Pop-Location }
}

function Invoke-Build {
  Write-Host "Building dashboard..."
  Push-Location (Join-Path $ProjectDir "dashboard")
  try { bun run build } finally { Pop-Location }
  Write-Host "Restarting..."
  Invoke-Stop
  Start-Sleep -Seconds 1
  Invoke-Start
}

function Invoke-Port([string]$apiPort, [string]$dashPort) {
  if (-not $apiPort -or -not $dashPort) {
    Write-Host "Current ports: API=$(Get-EnvValue 'PORT' '1630') Dashboard=$(Get-EnvValue 'DASHBOARD_PORT' '1631')"
    Write-Host "Usage: etteum port <api_port> <dashboard_port>"
    return
  }
  $content = Get-Content $EnvFile
  $content = $content -replace "^PORT=.*", "PORT=$apiPort"
  $content = $content -replace "^DASHBOARD_PORT=.*", "DASHBOARD_PORT=$dashPort"
  $content | Set-Content $EnvFile
  Write-Host "Ports changed: API=$apiPort Dashboard=$dashPort" -ForegroundColor Green
  if (Test-Running) {
    Write-Host "Restarting with new ports..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  }
}

switch ($Command.ToLower()) {
  "start"   {
    # Detect --watch / --dev / -w in either positional slot.
    $watch = ($Arg1 -in "--watch","--dev","-w") -or ($Arg2 -in "--watch","--dev","-w")
    Invoke-Start -Watch:$watch
  }
  "stop"    { Invoke-Stop }
  "restart" {
    $watch = ($Arg1 -in "--watch","--dev","-w") -or ($Arg2 -in "--watch","--dev","-w")
    Invoke-Stop; Start-Sleep -Seconds 1; Invoke-Start -Watch:$watch
  }
  "dev"     { Invoke-Start -Watch:$true }
  "status"  { Invoke-Status }
  "logs"    { Invoke-Logs $Arg1 }
  "update"  { Invoke-Update }
  "build"   { Invoke-Build }
  "port"    { Invoke-Port $Arg1 $Arg2 }
  default {
    Write-Host "etteum - Etteum Management CLI (Windows)`n"
    Write-Host "Usage: etteum <command> [flags]`n"
    Write-Host "Commands:"
    Write-Host "  start [--watch]   Start the server (--watch enables hot-reload)"
    Write-Host "  stop              Stop the server"
    Write-Host "  restart [--watch] Restart the server"
    Write-Host "  dev               Alias for: start --watch"
    Write-Host "  status            Show server status"
    Write-Host "  logs              Follow server logs (etteum logs -f)"
    Write-Host "  update            Pull git, install deps, build, restart"
    Write-Host "  build             Rebuild dashboard and restart"
    Write-Host "  port              Show/change ports (etteum port 1930 1931)"
  }
}
