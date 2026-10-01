# 静默安装 NSIS 安装包（electron-builder 产物）。参数经环境变量 KIT_EXE/KIT_DIR 传入。
$ErrorActionPreference = 'Stop'
$Exe = $env:KIT_EXE
$Dir = $env:KIT_DIR
if (-not $Exe -or -not $Dir) { Write-Output "ERR=missing env"; exit 90 }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$p = Start-Process -FilePath $Exe -ArgumentList "/S /D=$Dir" -Wait -PassThru -WindowStyle Hidden
Write-Output ("EXIT=" + $p.ExitCode)
