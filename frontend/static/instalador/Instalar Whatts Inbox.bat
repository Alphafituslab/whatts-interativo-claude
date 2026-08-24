@echo off
REM ============================================================
REM  Whatts Inbox - instalador do atalho na area de trabalho
REM
REM  Nao instala programa nenhum: so cria o atalho que abre o
REM  sistema em modo aplicativo (sem barra de endereco), ja com a
REM  logo da empresa. Nao precisa ser administrador.
REM
REM  E so dar dois cliques neste arquivo.
REM ============================================================
title Instalar Whatts Inbox

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"

if errorlevel 1 (
  echo.
  echo Algo deu errado. Tire uma foto desta tela e mande pro suporte.
  pause
)
