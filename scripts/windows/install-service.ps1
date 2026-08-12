# =============================================================================
# TsumiWiki を Windows サービスとして登録する(NSSM 経由)
#
# 前提:
#   NSSM (https://nssm.cc/) が PATH にある、もしくは nssm.exe をこのスクリプトの
#   隣に置く。
#     winget install NSSM.NSSM
#
# 使い方(管理者 PowerShell):
#   cd C:\tsumiwiki
#   .\scripts\windows\install-service.ps1
#
# 動作:
#   - サービス名 "TsumiWiki" で登録
#   - start-local.bat があればそれを、なければ start.bat を実行対象にする
#   - 作業ディレクトリをリポジトリルートに設定
#   - stdout/stderr を C:\tsumiwiki-data\service-*.log にリダイレクト
#   - 自動起動に設定して、そのまま開始
# =============================================================================

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$ServiceName = 'TsumiWiki'
$DisplayName = 'TsumiWiki Server'
$Description = 'TsumiWiki markdown wiki server (Node.js / Fastify).'
$LogDir      = 'C:\tsumiwiki-data'

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

# --- パス解決 ---------------------------------------------------------------
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$appBat = Join-Path $PSScriptRoot 'start-local.bat'
if (-not (Test-Path $appBat)) {
    $appBat = Join-Path $PSScriptRoot 'start.bat'
}

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

# --- 既存サービスは触らずエラーにする --------------------------------------
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Error "サービス '$ServiceName' は既に存在します。先に uninstall-service.ps1 を実行するか、`nssm edit $ServiceName` を使ってください。"
    exit 1
}

Write-Host "=== サービス '$ServiceName' を登録します ==="
Write-Host "  NSSM  : $nssm"
Write-Host "  App   : $appBat"
Write-Host "  CWD   : $repoRoot"
Write-Host "  Logs  : $LogDir\service-stdout.log / service-stderr.log"
Write-Host ''

& $nssm install $ServiceName $appBat
if ($LASTEXITCODE -ne 0) { throw 'nssm install が失敗しました。' }

& $nssm set $ServiceName AppDirectory          $repoRoot
& $nssm set $ServiceName DisplayName           $DisplayName
& $nssm set $ServiceName Description           $Description
& $nssm set $ServiceName Start                 SERVICE_AUTO_START
& $nssm set $ServiceName AppStdout             (Join-Path $LogDir 'service-stdout.log')
& $nssm set $ServiceName AppStderr             (Join-Path $LogDir 'service-stderr.log')
& $nssm set $ServiceName AppRotateFiles        1
& $nssm set $ServiceName AppRotateBytes        10485760
# 停止手順: Ctrl+C を送って 15 秒待ち、駄目ならプロセスツリーを kill
& $nssm set $ServiceName AppStopMethodSkip     0
& $nssm set $ServiceName AppStopMethodConsole  15000
& $nssm set $ServiceName AppStopMethodWindow   15000
& $nssm set $ServiceName AppStopMethodThreads  15000

Write-Host ''
Write-Host '=== 開始します ==='
& $nssm start $ServiceName
if ($LASTEXITCODE -ne 0) { throw 'nssm start が失敗しました。ログを確認してください。' }

Write-Host ''
Write-Host '=== 完了 ==='
Write-Host "  状態    : Get-Service $ServiceName"
Write-Host "  停止    : nssm stop $ServiceName"
Write-Host "  設定変更: nssm edit $ServiceName"
Write-Host "  削除    : .\scripts\windows\uninstall-service.ps1"
