@echo off
REM Só o API. Para Next + API juntos, usa run_dev.bat na raiz do repo (pasta backtest).
cd /d "%~dp0"
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
