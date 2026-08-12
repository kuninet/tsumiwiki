@echo off
REM ============================================================================
REM TsumiWiki: unregister the Windows service (via NSSM).
REM
REM Usage (Run as Administrator):
REM   cd C:\tsumiwiki
REM   scripts\windows\uninstall-service.bat
REM
REM Comments are ASCII-only on purpose.
REM ============================================================================

setlocal
chcp 65001 >nul

set "SERVICE_NAME=TsumiWiki"

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

REM --- Skip if not installed --------------------------------------------------
sc query "%SERVICE_NAME%" >nul 2>nul
if errorlevel 1 (
  echo Service "%SERVICE_NAME%" is not installed. Nothing to do.
  endlocal
  exit /b 0
)

echo === Stopping service "%SERVICE_NAME%" ===
"%NSSM_EXE%" stop "%SERVICE_NAME%"

echo.
echo === Removing service "%SERVICE_NAME%" ===
"%NSSM_EXE%" remove "%SERVICE_NAME%" confirm
if errorlevel 1 (
  echo *** Service removal failed.
  endlocal
  exit /b 1
)

echo.
echo === Done ===
echo   The log files in C:\tsumiwiki-data are left in place on purpose.
endlocal
exit /b 0
