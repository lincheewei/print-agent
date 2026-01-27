@echo off
set URL=http://localhost:5173
set HEALTH=http://localhost:9000/health

echo Waiting for agent health...

:wait
curl -s %HEALTH% >nul
if errorlevel 1 (
  timeout /t 2 >nul
  goto wait
)

echo Agent healthy. Starting browser...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk %URL%