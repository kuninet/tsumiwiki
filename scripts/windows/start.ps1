# =============================================================================
# TsumiWiki 手動起動スクリプト(Windows / PowerShell)
# 環境変数はこのプロセス内(スクリプト実行のセッション)にだけ定義するため、
# 呼び出し元シェルや他アプリケーションと衝突しない。
#
# 使い方:
#   1. 下の $env: 行を自環境に合わせて書き換える
#   2. PowerShell を開く
#   3. cd C:\tsumiwiki\scripts\windows したうえで
#      .\start.ps1
#      (初回は Set-ExecutionPolicy -Scope Process Bypass が必要な場合あり)
# =============================================================================

# --- 必須項目 --------------------------------------------------------------
$env:LIBRARY_PATH = 'C:\tsumiwiki-library'
$env:DB_PATH      = 'C:\tsumiwiki-data\app.db'

# --- 待ち受け設定(3000は他のNodeツールと衝突しがちなので変更を推奨) ------
$env:PORT = '3080'
$env:HOST = '0.0.0.0'

# --- バックアップ(省略可)-------------------------------------------------
$env:BACKUP_REMOTE                = '\\fileserver\share\tsumiwiki.git'
$env:BACKUP_PUSH_INTERVAL_MINUTES = '10'

# --- ログ(省略時は標準出力)-----------------------------------------------
$env:LOG_FILE = 'C:\tsumiwiki-data\app.log'

# =============================================================================
# サーバー起動
# =============================================================================
$repoRoot = Resolve-Path "$PSScriptRoot\..\.."
Push-Location $repoRoot
try {
    pnpm --filter @tsumiwiki/server start
} finally {
    Pop-Location
}
