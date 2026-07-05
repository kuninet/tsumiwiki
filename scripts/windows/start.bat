@echo off
REM ============================================================================
REM TsumiWiki 手動起動バッチ(Windows)
REM 環境変数はこの中で setlocal 配下に定義するため、親のコマンドプロンプトや
REM システム環境に一切漏れず、他アプリケーションと衝突しない。
REM
REM 使い方:
REM   1. 下の SET 行を自環境に合わせて書き換える
REM   2. スタートメニュー等から「PowerShell」または「コマンドプロンプト」を開く
REM   3. cd C:\tsumiwiki して start.bat を実行
REM ============================================================================

setlocal

REM --- 必須項目 ------------------------------------------------------------
set "LIBRARY_PATH=C:\tsumiwiki-library"
set "DB_PATH=C:\tsumiwiki-data\app.db"

REM --- 待ち受け設定(3000は他のNodeツールと衝突しがちなので変更を推奨) ---
set "PORT=3080"
set "HOST=0.0.0.0"

REM --- バックアップ(省略可)----------------------------------------------
set "BACKUP_REMOTE=\\fileserver\share\tsumiwiki.git"
set "BACKUP_PUSH_INTERVAL_MINUTES=10"

REM --- ログ(省略時は標準出力)---------------------------------------------
set "LOG_FILE=C:\tsumiwiki-data\app.log"

REM ============================================================================
REM サーバー起動
REM ============================================================================
pushd "%~dp0\..\.."
call pnpm --filter @tsumiwiki/server start
popd

endlocal
