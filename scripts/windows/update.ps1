# =============================================================================
# TsumiWiki update script for Windows / PowerShell.
#
# 1. Preflight: git / pnpm must be on PATH (an elevated prompt may lack
#    user-level tools such as fnm / nvm-windows / corepack).
# 2. If service "TsumiWiki" is running, stop it (requires an elevated prompt;
#    aborts before touching anything when not elevated).
# 3. git pull -> pnpm install -> pnpm build.
# 4. Restart the service that was stopped.
#
# Failure behavior:
#   - git pull failed: nothing has changed yet, so the service is restarted.
#   - pnpm install / build failed: the build tree may be broken (vite empties
#     client dist before building), so the service is left STOPPED on purpose
#     instead of serving a corrupted SPA. Fix and re-run, or roll back and
#     start manually with "nssm start TsumiWiki".
#   - Any failure exits with code 1.
#
# When the server runs via start.ps1 / start-local.ps1 (no service), this
# script only updates; stop the console with Ctrl+C and start it again.
#
# Usage:
#   cd C:\tsumiwiki
#   .\scripts\windows\update.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'
# PowerShell 7.4+ turns native non-zero exits into terminating errors under
# ErrorActionPreference=Stop; keep the manual $LASTEXITCODE handling below.
$PSNativeCommandUseErrorActionPreference = $false

$ServiceName = 'TsumiWiki'

$script:exitCode = 0
$script:serviceExists = $false
$script:serviceStopped = $false
$script:treeDirty = $false   # true once pnpm install has started
$script:buildOk = $false     # true only after pnpm build succeeded

function Invoke-Update {
    foreach ($cmd in 'git', 'pnpm') {
        if ($null -eq (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Write-Host "*** '$cmd' not found in PATH. An elevated prompt may lack user-level tools (fnm / nvm-windows / corepack)." -ForegroundColor Red
            $script:exitCode = 1
            return
        }
    }

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $script:serviceExists = ($null -ne $service)
    if ($script:serviceExists -and $service.Status -in 'Running', 'StartPending') {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            Write-Host "*** Service '$ServiceName' is running. Run this from an elevated PowerShell so the service can be stopped and restarted. Nothing was changed." -ForegroundColor Red
            $script:exitCode = 1
            return
        }

        Write-Host "=== Stopping service '$ServiceName' ==="
        try {
            Stop-Service -Name $ServiceName -Force
            $script:serviceStopped = $true
        } catch {
            $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if ($null -ne $svc -and $svc.Status -ne 'Running') {
                # Stop reported an error (e.g. SCM timeout) but the service
                # did go down; make sure it gets restarted afterwards.
                Write-Host '*** Stop reported an error but the service is no longer running; it will be restarted after the update.' -ForegroundColor Yellow
                $script:serviceStopped = $true
            } else {
                Write-Host "*** Failed to stop service '$ServiceName'. Nothing was changed." -ForegroundColor Red
                $script:exitCode = 1
                return
            }
        }
        Write-Host ''
    }

    Write-Host '=== git pull ==='
    git pull
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '*** git pull failed. Resolve conflicts or stash local changes, then retry.' -ForegroundColor Red
        $script:exitCode = 1
        return
    }

    $script:treeDirty = $true

    Write-Host ''
    Write-Host '=== pnpm install ==='
    pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host '*** pnpm install failed.' -ForegroundColor Red
        $script:exitCode = 1
        return
    }

    Write-Host ''
    Write-Host '=== pnpm build ==='
    pnpm build
    if ($LASTEXITCODE -ne 0) {
        Write-Host '*** pnpm build failed.' -ForegroundColor Red
        $script:exitCode = 1
        return
    }
    $script:buildOk = $true

    Write-Host ''
    Write-Host '=== update complete ===' -ForegroundColor Green
    if (-not $script:serviceStopped) {
        if ($script:serviceExists) {
            Write-Host "Service '$ServiceName' is installed but was not running. Start it with: nssm start $ServiceName"
        } else {
            Write-Host 'Restart the server (Ctrl+C on start.ps1 then re-run).'
        }
    }
}

$repoRoot = Resolve-Path "$PSScriptRoot\..\.."
Push-Location $repoRoot
try {
    Invoke-Update
} catch {
    Write-Host "*** Unexpected error: $_" -ForegroundColor Red
    $script:exitCode = 1
} finally {
    if ($script:serviceStopped) {
        Write-Host ''
        if ($script:buildOk -or -not $script:treeDirty) {
            Write-Host "=== Starting service '$ServiceName' ==="
            try {
                Start-Service -Name $ServiceName
                Write-Host "Service '$ServiceName' restarted." -ForegroundColor Green
            } catch {
                Write-Host "*** Failed to start service '$ServiceName'. Start it manually: nssm start $ServiceName" -ForegroundColor Red
                $script:exitCode = 1
            }
        } else {
            Write-Host "*** Leaving service '$ServiceName' STOPPED on purpose: the build tree may be broken and would serve a corrupted SPA." -ForegroundColor Red
            Write-Host "    Fix the error above and re-run this script, or roll back and start manually: nssm start $ServiceName"
        }
    }
    Pop-Location
}
exit $script:exitCode
