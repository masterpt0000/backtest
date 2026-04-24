@echo off
setlocal
cd /d "%~dp0"

set "BACKEND_DIR=%~dp0backend"
set "PY=python"
if exist "%BACKEND_DIR%\.venv\Scripts\python.exe" set "PY=%BACKEND_DIR%\.venv\Scripts\python.exe"
if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"

REM FastAPI na porta 8000 (janela separada) — o Next precisa disto para /api/*.
start "backtest FastAPI" cmd /k "cd /d ""%BACKEND_DIR%"" && ""%PY%"" -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload"

timeout /t 2 /nobreak >nul

cd /d "%~dp0my-app"
REM Evita que o Node envie pedidos locais para um proxy HTTP global (undici/fetch).
set NO_PROXY=127.0.0.1,localhost
set no_proxy=127.0.0.1,localhost
echo.
echo Next.js:  http://localhost:3000
echo FastAPI: http://127.0.0.1:8000  (janela "backtest FastAPI" — fecha-a para parar o API)
echo.
call npm run dev
