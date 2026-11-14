# Serves the built web app and the API on http://127.0.0.1:8000 (localhost only).
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PYTHONIOENCODING = "utf-8"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
if (-not (Test-Path "$root\web\dist")) { Write-Host "web\dist not found: run 'npm run build' in web first." -ForegroundColor Yellow }
Set-Location "$root\server"
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level warning
