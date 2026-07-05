@echo off
REM ============================================================================
REM TsumiWiki update batch for Windows.
REM 1. git pull main
REM 2. pnpm install (in case deps changed)
REM 3. pnpm build (rebuild the SPA)
REM
REM The running server does not restart itself. If you use NSSM, restart the
REM service after this finishes. If you use start.bat / start-local.bat, stop
REM the console (Ctrl+C) and start it again.
REM
REM Usage:
REM   cd C:\tsumiwiki
REM   scripts\windows\update.bat
REM ============================================================================

setlocal
chcp 65001 >nul

pushd "%~dp0\..\.."

echo === git pull ===
git pull
if errorlevel 1 (
  echo.
  echo *** git pull failed. Resolve conflicts or stash local changes, then retry.
  goto :end
)

echo.
echo === pnpm install ===
call pnpm install
if errorlevel 1 (
  echo.
  echo *** pnpm install failed.
  goto :end
)

echo.
echo === pnpm build ===
call pnpm build
if errorlevel 1 (
  echo.
  echo *** pnpm build failed.
  goto :end
)

echo.
echo === update complete ===
echo Restart the server (Ctrl+C on start.bat then re-run, or "nssm restart TsumiWiki").

:end
popd
endlocal
