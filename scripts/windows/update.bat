@echo off
REM ============================================================================
REM TsumiWiki update batch for Windows - thin wrapper around update.ps1.
REM
REM All logic lives in update.ps1 on purpose:
REM  - "git pull" during the update may rewrite this very file. cmd.exe re-reads
REM    a .bat by byte offset mid-run, which corrupts execution (dangerous now
REM    that the update stops the service first). PowerShell parses the whole
REM    script up front, so update.ps1 is immune to being rewritten.
REM  - It keeps the stop / update / restart logic in one place.
REM Comments are ASCII-only on purpose (Shift-JIS console mojibake).
REM
REM Run from an elevated prompt when the TsumiWiki service is running.
REM
REM Usage:
REM   cd C:\tsumiwiki
REM   scripts\windows\update.bat
REM ============================================================================

REM Single line so cmd.exe never re-reads this file after git pull rewrites it.
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %* & exit /b
