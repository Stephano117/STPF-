@echo off
chcp 65001 >nul
title SPTF
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 ou plus est requis : https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\hono" (
  echo Installation des dependances, premiere fois uniquement...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo L'installation a echoue. Verifiez votre connexion Internet.
    pause
    exit /b 1
  )
)

call npm run local
pause
