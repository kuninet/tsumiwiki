@echo off
REM ============================================================================
REM TsumiWiki startup batch for Windows.
REM All env vars are set inside a setlocal block so they never leak to the
REM parent shell or the system environment.
REM
REM Usage:
REM   1. Copy this file to start-local.bat (gitignored) and edit that copy so
REM      your local tweaks are not disturbed by future git pulls:
REM          copy scripts\windows\start.bat scripts\windows\start-local.bat
REM   2. Edit the SET lines below (or in start-local.bat) to match your env.
REM   3. Open Command Prompt or PowerShell.
REM   4. cd C:\tsumiwiki and run: scripts\windows\start-local.bat
REM
REM Note: comments are ASCII-only on purpose. Legacy Windows cmd.exe reads
REM .bat files with the system code page (Shift-JIS on Japanese Windows) and
REM will mojibake / choke on multi-byte characters even in REM lines.
REM ============================================================================

setlocal
REM Switch console code page to UTF-8 so Japanese paths passed to node work.
chcp 65001 >nul

REM --- Required -----------------------------------------------------------
set "LIBRARY_PATH=C:\tsumiwiki-library"
set "DB_PATH=C:\tsumiwiki-data\app.db"

REM --- Listen address (change PORT to avoid conflicts with other Node apps) -
set "PORT=3080"
set "HOST=0.0.0.0"

REM --- Backup (optional) --------------------------------------------------
set "BACKUP_REMOTE=\\fileserver\share\tsumiwiki.git"
set "BACKUP_PUSH_INTERVAL_MINUTES=10"

REM --- Log (defaults to stdout if unset) ----------------------------------
set "LOG_FILE=C:\tsumiwiki-data\app.log"

REM ============================================================================
REM Start the server. Change directory to the repository root so pnpm can find
REM the workspace.
REM ============================================================================
pushd "%~dp0\..\.."
call pnpm --filter @tsumiwiki/server start
popd

endlocal
