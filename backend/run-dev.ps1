# Arranca o Backtest API em http://127.0.0.1:8000 (necessario para o Next.js via BACKEND_URL).
# Uso: na pasta backend:  .\run-dev.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".env")) {
  Write-Warning "Cria ``backend/.env`` a partir de ``.env.example`` (QuestDB, etc.)"
}
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
