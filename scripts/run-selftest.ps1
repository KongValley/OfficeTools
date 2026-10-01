# 跑侧车 selftest（双架构）。用法：powershell -ExecutionPolicy Bypass -File scripts\run-selftest.ps1 -Arch x64
param(
    [Parameter(Mandatory = $true, Position = 0)][ValidateSet("x64", "ia32")]$Arch
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$py = Join-Path $root "staging\sidecar-$Arch\python.exe"
$wk = Join-Path $root "staging\sidecar-$Arch\worker.py"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"
$env:PYTHONLEGACYWINDOWSSTDIO = "1"
& $py $wk --selftest
exit $LASTEXITCODE
