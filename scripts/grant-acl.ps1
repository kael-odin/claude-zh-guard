$log = "$env:LOCALAPPDATA\claude-zh-guard\acl.log"
"start $(Get-Date -Format 'HH:mm:ss') user=$env:USERNAME elevated=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" | Out-File $log -Encoding utf8
$pkg = "C:\Program Files\WindowsApps\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc"

$out = & takeown /F "$pkg\app\resources" /R /D Y 2>&1
"takeown exit=$LASTEXITCODE lines=$(($out | Measure-Object).Count): $($out | Select-Object -First 3 | Out-String)" | Out-File $log -Append -Encoding utf8

$out2 = & icacls "$pkg\app\resources" /grant "$($env:USERNAME):(OI)F" 2>&1
"icacls exit=$LASTEXITCODE: $($out2 | Out-String)" | Out-File $log -Append -Encoding utf8

# .NET Set-Acl 备选
try {
  $acl = Get-Acl "$pkg\app\resources"
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
  $acl.SetAccessRule($rule)
  Set-Acl -Path "$pkg\app\resources" -AclObject $acl -ErrorAction Stop
  "Set-Acl: OK" | Out-File $log -Append -Encoding utf8
} catch {
  "Set-Acl FAIL: $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
}

try {
  $probe = "$pkg\app\resources\.zhguard-probe"
  "probe" | Out-File $probe -Encoding utf8
  Remove-Item $probe -Force
  "WRITABLE: yes" | Out-File $log -Append -Encoding utf8
} catch {
  "WRITABLE: NO - $($_.Exception.Message)" | Out-File $log -Append -Encoding utf8
}
"done $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Append -Encoding utf8
