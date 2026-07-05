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
echo  DiningLens Server
echo  ========================================
echo.
echo  Host IP addresses (use from other devices on your network):
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i /c:"IPv4"') do (
  set "ip=%%a"
  set "ip=!ip:~1!"
  if not "!ip!"=="" echo    http://!ip!:!PORT!
)
echo.
echo  Local URL:
echo    http://localhost:!PORT!
echo.
echo  Press Ctrl+C to stop the server.
echo.

call npm run dev
