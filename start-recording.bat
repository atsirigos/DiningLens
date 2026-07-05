@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set "PORT=3000"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)

echo.
echo  SmartDining — Start Recording
echo  ========================================
echo.

set "SERVER_UP=0"
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:%PORT%/api/recording/status' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %ERRORLEVEL% equ 0 set "SERVER_UP=1"

if "%SERVER_UP%"=="1" (
  echo  Server already running on port %PORT%.
) else (
  echo  Server not detected. Starting in a new window...
  start "SmartDining" cmd /c "npm run dev"
  echo  Waiting for server to start...
  set /a ATTEMPTS=0
  :wait_loop
  set /a ATTEMPTS+=1
  if !ATTEMPTS! gtr 30 (
    echo  ERROR: Server did not respond within 30 seconds.
    echo  Try running start-server.bat manually.
    pause
    exit /b 1
  )
  timeout /t 1 /nobreak >nul
  set "SERVER_UP=0"
  powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:%PORT%/api/recording/status' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if %ERRORLEVEL% equ 0 set "SERVER_UP=1"
  if "%SERVER_UP%"=="0" goto wait_loop
  echo  Server is ready.
)

echo  Opening recording page...
start "" "http://localhost:%PORT%/start-recording.html"
echo.
echo  Done. You can close this window.
echo.
timeout /t 3 /nobreak >nul
