# 安装 x86 VC++ 运行库（静默，无交互）。用法：powershell -ExecutionPolicy Bypass -File scripts\install-vcredist.ps1 -Exe <path>
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Exe
)
if (-not (Test-Path $Exe)) { Write-Output "ERR: not found $Exe"; exit 90 }
$p = Start-Process -FilePath $Exe -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
Write-Output ("exit=" + $p.ExitCode)
$dll = Join-Path $env:SystemRoot 'SysWOW64\vcruntime140_1.dll'
if (Test-Path $dll) { Write-Output "DLL_OK" } else { Write-Output "DLL_MISSING" }
