$log = "$env:LOCALAPPDATA\claude-zh-guard\deploy.log"
"start $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Encoding utf8
Stop-Service CoworkVMService -Force -ErrorAction SilentlyContinue
try {
  Add-AppxPackage -Path "$env:LOCALAPPDATA\claude-zh-guard\downloads\Claude-4.4212.0.msix" -ErrorAction Stop
  "DEPLOY OK: $((Get-AppxPackage *Claude*).Version)" | Out-File $log -Append -Encoding utf8
} catch {
  "DEPLOY FAIL: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
}
Start-Service CoworkVMService -ErrorAction SilentlyContinue
"done $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Append -Encoding utf8
