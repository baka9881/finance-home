$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$Root\backend\.venv\Scripts\python.exe")) {
    py -3.11 -m venv "$Root\backend\.venv"
}

& "$Root\backend\.venv\Scripts\python.exe" -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Failed to update pip." }
& "$Root\backend\.venv\Scripts\python.exe" -m pip install -r "$Root\backend\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "Failed to install Python dependencies." }

Push-Location "$Root\frontend"
try {
    npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw "Failed to install frontend dependencies." }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "Failed to build the frontend." }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Setup complete. Run .\run.ps1 to start the app." -ForegroundColor Green

