$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = "$Root\backend\.venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
    throw "Dependencies are not installed. Run setup.cmd first."
}

if (-not (Test-Path "$Root\frontend\dist\index.html")) {
    throw "The frontend has not been built. Run setup.cmd first."
}

$env:APP_MODE = "demo"
Write-Host "Demo finance app is running at http://127.0.0.1:8000" -ForegroundColor Cyan
Write-Host "Demo data is stored separately in data\demo.db. Press Ctrl+C to stop the app."
& $Python -m uvicorn app.main:app --app-dir "$Root\backend" --host 127.0.0.1 --port 8000
