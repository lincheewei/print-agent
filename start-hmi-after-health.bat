@echo off

set HEALTH=http://localhost:9000/health
set AGENT_ID=warehouse-terminal-003
set APP_URL=http://ec2-43-216-246-220.ap-southeast-5.compute.amazonaws.com:5173
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"

echo Waiting for agent health...

:wait
curl -s %HEALTH% >nul
if errorlevel 1 (
  timeout /t 2 >nul
  goto wait
)

echo Agent healthy. Starting browser...
start "" %CHROME% ^
  --kiosk ^
  --noerrdialogs ^
  --disable-infobars ^
  --start-fullscreen ^
  %APP_URL%