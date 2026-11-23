@echo off
setlocal
title Infiniq
cd /d "%~dp0"

rem ---- Find Node.js: 1) "node" folder inside this app, 2) D:\nodejs, 3) already installed ----
if exist "%~dp0node\node.exe" (
  set "PATH=%~dp0node;%PATH%"
  goto found
)
for /d %%D in ("%~dp0node-v*") do if exist "%%D\node.exe" (
  set "PATH=%%D;%PATH%"
  goto found
)
if exist "D:\nodejs\node.exe" (
  set "PATH=D:\nodejs;%PATH%"
  goto found
)
where node >nul 2>nul
if %errorlevel%==0 goto found

echo.
echo  Node.js was not found.
echo.
echo  1. Go to https://nodejs.org/en/download
echo  2. Choose Windows, and "Standalone Binary (.zip)" (x64; or ARM64 for Snapdragon laptops)
echo  3. Unzip it INTO THIS FOLDER:  %~dp0
echo     so that this file exists:  %~dp0node-v...\node.exe
echo  4. Double-click start-windows.bat again.
echo.
pause
exit /b 1

:found
echo Using Node.js:
node -v
if errorlevel 1 (
  echo node.exe was found but could not run. Your antivirus or company policy may be blocking it.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo This app needs Node.js 22.13 or newer. Please download the latest LTS version.
  pause
  exit /b 1
)

rem keep npm's download cache on this drive instead of C:
set "npm_config_cache=%~dp0.npm-cache"

if not exist "%~dp0node_modules\express" (
  echo.
  echo Installing the app's libraries ^(first time only, needs internet^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Copy the messages above and send them for help.
    pause
    exit /b 1
  )
)

echo.
echo Starting Infiniq... open http://localhost:3000 in Chrome or Edge.
echo Sign-in codes and test emails: http://localhost:3000/dev/outbox
echo Close this window (or press Ctrl+C) to stop the app.
echo.
start "" http://localhost:3000
call npm start
pause
