param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Dir
)
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$p = Start-Process -FilePath $Exe -ArgumentList "/S", ("/D=" + $Dir) -Wait -PassThru -WindowStyle Hidden
Write-Output ("EXIT=" + $p.ExitCode)
$exe = Join-Path $Dir "办公助手.exe"
if (Test-Path $exe) { Write-Output "APP_OK" } else { Write-Output "APP_MISSING" }
