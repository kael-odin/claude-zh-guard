Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ClaudeWindow {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
}
"@
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  $targets = New-Object System.Collections.ArrayList
  $cb = [ClaudeWindow+EnumProc]{
    param($h, $l)
    $pid2 = 0
    [ClaudeWindow]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'claude') {
      $sb = New-Object System.Text.StringBuilder 256
      [ClaudeWindow]::GetWindowText($h, $sb, 256) | Out-Null
      if ($sb.ToString() -eq 'Claude') { [void]$targets.Add($h) }
    }
    return $true
  }
  [ClaudeWindow]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($targets.Count -gt 0) {
    foreach ($h in $targets) {
      [ClaudeWindow]::ShowWindow($h, 9) | Out-Null
      [ClaudeWindow]::SetForegroundWindow($h) | Out-Null
    }
    exit 0
  }
  Start-Sleep -Milliseconds 800
}
exit 1
