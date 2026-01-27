@echo off

REM === Force correct working directory ===
cd /d C:\print-agent

REM === Start Node with absolute path ===
"C:\Program Files\nodejs\node.exe" server.js >> logs\agent.log 2>&1