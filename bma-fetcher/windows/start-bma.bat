@echo off
rem BKK flood map - BMA sensor relay for Windows. Double-click to start.
rem Downloads the latest runner from GitHub, then runs it. Add "reset" to enter a new token.
title BKK flood - BMA sensor relay
set "D=%LOCALAPPDATA%\bkk-flood-bma"
if not exist "%D%" mkdir "%D%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/apichaetth/bkk-flood-map/main/bma-fetcher/windows/bma-run.ps1' -OutFile '%D%\bma-run.ps1.new'; Move-Item -Force '%D%\bma-run.ps1.new' '%D%\bma-run.ps1' } catch { Write-Host 'Offline - using the saved copy' }"
if not exist "%D%\bma-run.ps1" (
  echo Cannot download the runner. Check the internet connection and try again.
  pause
  exit /b 1
)
set "R="
if /i "%~1"=="reset" set "R=-Reset"
powershell -NoProfile -ExecutionPolicy Bypass -File "%D%\bma-run.ps1" -Launcher "%~f0" %R%
rem 3 = another relay window is already running: close quietly
if "%ERRORLEVEL%"=="3" exit /b 0
echo.
echo Stopped. Double-click this file again to restart.
pause
