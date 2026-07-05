# =============================================================================
# TsumiWiki update script for Windows / PowerShell.
# 1. git pull main
# 2. pnpm install (in case deps changed)
# 3. pnpm build (rebuild the SPA)
#
# The running server does not restart itself. If you use NSSM, restart the
# service after this finishes. If you use start.ps1 / start-local.ps1, stop
# the console (Ctrl+C) and start it again.
#
# Usage:
#   cd C:\tsumiwiki
#   .\scripts\windows\update.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path "$PSScriptRoot\..\.."
Push-Location $repoRoot
try {
    Write-Host '=== git pull ==='
    git pull
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '*** git pull failed. Resolve conflicts or stash local changes, then retry.' -ForegroundColor Red
        return
    }

    Write-Host ''
    Write-Host '=== pnpm install ==='
    pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host '*** pnpm install failed.' -ForegroundColor Red
        return
    }

    Write-Host ''
    Write-Host '=== pnpm build ==='
    pnpm build
    if ($LASTEXITCODE -ne 0) {
        Write-Host '*** pnpm build failed.' -ForegroundColor Red
        return
    }

    Write-Host ''
    Write-Host '=== update complete ===' -ForegroundColor Green
    Write-Host 'Restart the server (Ctrl+C on start.ps1 then re-run, or "nssm restart TsumiWiki").'
} finally {
    Pop-Location
}
