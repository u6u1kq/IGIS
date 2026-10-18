@echo off
setlocal
cd /d "%~dp0"
echo Starting Igis at http://127.0.0.1:39221
start "Igis" cmd /k npx --yes tsx --tsconfig tsconfig.json apps/cli/src/desktop-api.ts
set /a tries=0
:waitloop
set /a tries+=1
if %tries% GTR 40 goto openwindow
curl -fsS http://127.0.0.1:39221/api/health >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto waitloop
)
:openwindow
set "IGIS_EXE=%~dp0apps\desktop\src-tauri\target\release\igis.exe"
if not exist "%IGIS_EXE%" set "IGIS_EXE=%~dp0apps\desktop\src-tauri\target\debug\igis.exe"
if not exist "%IGIS_EXE%" (
  echo Igis window was not built.
  endlocal
  exit /b 1
)
start "" "%IGIS_EXE%"
endlocal
