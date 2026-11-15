@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  CONVERTI E OTTIMIZZA MODELLO PER IL VIEWER VR
rem  Uso: trascina il file .obj / .fbx / .glb esportato da Revit
rem       sopra questo file. Accanto all'originale compare
rem       il file NOME_quest.glb da caricare nel viewer.
rem  Per gli OBJ: tieni il file .mtl e le texture nella stessa
rem  cartella dell'.obj.
rem ============================================================

rem Asse verticale del file OBJ: Y (standard) oppure Z (se il modello appare sdraiato)
set UPAXIS=Y
rem Rotazione del modello in gradi. Revit ha la Z verso l'alto: ROTX=-90 lo raddrizza.
rem Se il modello e' ruotato dalla parte opposta usa ROTX=90.
rem Se e' dritto ma girato di lato usa ROTX=0 e ROTY=90 (oppure -90).
set ROTX=-90
set ROTY=0
set ROTZ=0
rem Dimensione massima delle texture (2048 = alta qualita', 1024 = piu' leggero)
set TEXSIZE=2048

if "%~1"=="" (
  echo Trascina un file .obj, .fbx o .glb sopra questo file.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js non e' installato. Scaricalo da https://nodejs.org ^(versione LTS^),
  echo installalo e poi riprova.
  pause
  exit /b 1
)

node "%~dp0converti.mjs" "%~1"
if errorlevel 1 (
  echo.
  echo Qualcosa e' andato storto. Copia il messaggio qui sopra e mandalo a Claude.
)
echo.
pause
