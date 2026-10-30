$log = "$env:LOCALAPPDATA\claude-zh-guard\elevated-install.log"
"start $(Get-Date -Format 'HH:mm:ss') elevated=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" | Out-File $log -Encoding utf8

# 1) 拿所有权 + 授权（完整输出入日志）
$out = & takeown /F "C:\Program Files\WindowsApps\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc" /R /D Y 2>&1
"takeown exit=$LASTEXITCODE, 输出行数=$(($out | Measure-Object).Count), 末行=$($out | Select-Object -Last 1)" | Out-File $log -Append -Encoding utf8
$out2 = & icacls "C:\Program Files\WindowsApps\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc" /grant "$($env:USERNAME):(OI)(CI)F" /T 2>&1
"icacls exit=$LASTEXITCODE, 末行=$($out2 | Select-Object -Last 1)" | Out-File $log -Append -Encoding utf8

# 2) 提权环境里直接跑安装
$out3 = & node "F:\kael\claude-zh-guard\src\cli.ts" install --yes 2>&1
"install exit=${LASTEXITCODE}:" | Out-File $log -Append -Encoding utf8
$out3 | Select-Object -Last 6 | Out-File $log -Append -Encoding utf8
"done $(Get-Date -Format 'HH:mm:ss')" | Out-File $log -Append -Encoding utf8
