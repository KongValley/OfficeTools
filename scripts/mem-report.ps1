# Report memory (MB) of the toolkit processes. Usage: powershell -ExecutionPolicy Bypass -File scripts\mem-report.ps1
$names = @("办公助手", "python", "pythonw", "soffice", "soffice.bin", "gswin64c", "gswin32c", "tesseract", "electron")
$rows = foreach ($n in $names) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
        [PSCustomObject]@{
            proc = $n
            pid = $_.Id
            memMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
            title = $_.MainWindowTitle
        }
    }
}
if (-not $rows) { Write-Output "NO_PROCESS"; exit 0 }
$rows | Sort-Object proc, pid | Format-Table -AutoSize | Out-String | Write-Output
$total = ($rows | Measure-Object memMB -Sum).Sum
Write-Output ("TOTAL_MB=" + [math]::Round($total, 1))
