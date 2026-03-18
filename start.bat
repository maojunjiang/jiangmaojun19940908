@echo off
cd /d "%~dp0"
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:3000/'"
node server.js
