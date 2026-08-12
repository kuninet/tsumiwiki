# =============================================================================
# TsumiWiki の Windows サービス登録を解除する(NSSM 経由)
#
# 使い方(管理者 PowerShell):
#   cd C:\tsumiwiki
#   .\scripts\windows\uninstall-service.ps1
# =============================================================================

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$ServiceName = 'TsumiWiki'

# --- nssm.exe を探す --------------------------------------------------------
$nssm = Join-Path $PSScriptRoot 'nssm.exe'
if (-not (Test-Path $nssm)) {
    $found = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($null -eq $found) {
        Write-Error 'nssm.exe が見つかりません。`winget install NSSM.NSSM` するか、このスクリプトの隣に nssm.exe を置いてください。'
        exit 1
    }
    $nssm = $found.Source
}

# --- 未登録なら何もしない ---------------------------------------------------
if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Write-Host "サービス '$ServiceName' は登録されていません。何もしません。"
    exit 0
}

Write-Host "=== '$ServiceName' を停止します ==="
& $nssm stop $ServiceName

Write-Host ''
Write-Host "=== '$ServiceName' を削除します ==="
& $nssm remove $ServiceName confirm
if ($LASTEXITCODE -ne 0) { throw 'nssm remove が失敗しました。' }

Write-Host ''
Write-Host '=== 完了 ==='
Write-Host '  C:\tsumiwiki-data のログファイルは残しています。'
