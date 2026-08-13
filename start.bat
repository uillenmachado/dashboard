@echo off
chcp 65001 >nul
title Dashboard Analitico - Notas Fiscais
echo.
echo Iniciando Dashboard Analitico...
echo.
cd /d "%~dp0"
node server\index.js
pause
