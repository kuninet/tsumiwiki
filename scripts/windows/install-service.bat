@echo off
REM ============================================================================
REM TsumiWiki: register as a Windows service (via NSSM).
REM
REM Prerequisite: NSSM (https://nssm.cc/) must be on PATH, or set NSSM_EXE
REM below to the full path of nssm.exe.
REM   - winget install NSSM.NSSM
REM   - or download the zip from nssm.cc and drop nssm.exe next to this file
REM     (this script will auto-detect it).
REM
REM Usage (Run as Administrator):
REM   cd C:\tsumiwiki
REM   scripts\windows\install-service.bat
REM
REM What this script does:
REM   - Registers a service named "TsumiWiki"
REM   - Runs start-local.bat if present, otherwise start.bat
REM   - Sets working directory to the repo root
REM   - Redirects stdout/stderr to C:\tsumiwiki-data\service-*.log
REM   - Sets Startup Type = Automatic
REM   - Starts the service
REM
REM Comments are ASCII-only on purpose (Shift-JIS console mojibake).
REM ============================================================================

setlocal
chcp 65001 >nul

set "SERVICE_NAME=TsumiWiki"
set "DISPLAY_NAME=TsumiWiki Server"
set "DESCRIPTION=TsumiWiki markdown wiki server (Node.js / Fastify)."
set "LOG_DIR=C:\tsumiwiki-data"

REM --- Locate nssm.exe --------------------------------------------------------
set "NSSM_EXE="
if exist "%~dp0nssm.exe" set "NSSM_EXE=%~dp0nssm.exe"
if not defined NSSM_EXE (
  where nssm.exe >nul 2>nul
  if not errorlevel 1 set "NSSM_EXE=nssm.exe"
)
if not defined NSSM_EXE (
  echo *** nssm.exe not found.
  echo     Install with: winget install NSSM.NSSM
  echo     or drop nssm.exe next to this script.
  exit /b 1
)

REM --- Require admin ----------------------------------------------------------
net session >nul 2>nul
if errorlevel 1 (
  echo *** Please run this script as Administrator.
  exit /b 1
)

REM --- Resolve paths ----------------------------------------------------------
pushd "%~dp0\..\.."
set "REPO_ROOT=%CD%"
popd

set "APP_BAT=%~dp0start-local.bat"
if not exist "%APP_BAT%" set "APP_BAT=%~dp0start.bat"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM --- If service already exists, refuse instead of silently changing it ------
sc query "%SERVICE_NAME%" >nul 2>nul
if not errorlevel 1 (
  echo *** Service "%SERVICE_NAME%" already exists.
  echo     Run uninstall-service.bat first, or use "nssm edit %SERVICE_NAME%".
  exit /b 1
)

echo === Registering service "%SERVICE_NAME%" ===
echo   NSSM  : %NSSM_EXE%
echo   App   : %APP_BAT%
echo   CWD   : %REPO_ROOT%
echo   Logs  : %LOG_DIR%\service-stdout.log / service-stderr.log
echo.

"%NSSM_EXE%" install "%SERVICE_NAME%" "%APP_BAT%"
if errorlevel 1 goto :fail

"%NSSM_EXE%" set "%SERVICE_NAME%" AppDirectory   "%REPO_ROOT%"
"%NSSM_EXE%" set "%SERVICE_NAME%" DisplayName    "%DISPLAY_NAME%"
"%NSSM_EXE%" set "%SERVICE_NAME%" Description    "%DESCRIPTION%"
"%NSSM_EXE%" set "%SERVICE_NAME%" Start          SERVICE_AUTO_START
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStdout      "%LOG_DIR%\service-stdout.log"
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStderr      "%LOG_DIR%\service-stderr.log"
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateFiles 1
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateBytes 10485760
REM Graceful stop: send Ctrl+C, wait up to 15s, then kill process tree.
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStopMethodSkip     0
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStopMethodConsole  15000
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStopMethodWindow   15000
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStopMethodThreads  15000

echo.
echo === Starting service ===
"%NSSM_EXE%" start "%SERVICE_NAME%"
if errorlevel 1 goto :fail

echo.
echo === Done ===
echo   Status : sc query %SERVICE_NAME%
echo   Stop   : nssm stop %SERVICE_NAME%
echo   Edit   : nssm edit %SERVICE_NAME%
echo   Remove : scripts\windows\uninstall-service.bat
endlocal
exit /b 0

:fail
echo.
echo *** Service registration failed.
endlocal
exit /b 1
