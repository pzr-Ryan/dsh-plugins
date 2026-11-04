param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'on', 'off', 'toggle')][string]$Action,
  [int]$TargetPid = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
}
"@

$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)
$SWP_NOMOVE = 0x0002
$SWP_NOSIZE = 0x0001
$SWP_NOACTIVATE = 0x0010
$GWL_EXSTYLE = -20
$WS_EX_TOPMOST = 0x00000008
$WS_EX_TOOLWINDOW = 0x00000080

function Get-Candidates {
  $list = New-Object System.Collections.ArrayList
  $cb = [DshWin32+EnumWindowsProc] {
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [DshWin32]::IsWindowVisible($hWnd)) { return $true }
    $text = New-Object System.Text.StringBuilder 512
    [void][DshWin32]::GetWindowTextW($hWnd, $text, 512)
    $title = $text.ToString()
    if ([string]::IsNullOrWhiteSpace($title)) { return $true }
    $procId = 0
    [void][DshWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    $rect = New-Object DshWin32+RECT
    [void][DshWin32]::GetWindowRect($hWnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -lt 300 -or $h -lt 200) { return $true }
    $ex = [DshWin32]::GetWindowLongPtr($hWnd, $GWL_EXSTYLE).ToInt64()
    if (($ex -band $WS_EX_TOOLWINDOW) -ne 0) { return $true }
    [void]$list.Add([pscustomobject]@{
      Hwnd = $hWnd; Pid = [int]$procId; Title = $title; Area = [int64]$w * [int64]$h; Topmost = (($ex -band $WS_EX_TOPMOST) -ne 0)
    })
    return $true
  }
  [void][DshWin32]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

$candidates = Get-Candidates
$target = $null
if ($TargetPid -gt 0) {
  $target = $candidates | Where-Object { $_.Pid -eq $TargetPid } | Sort-Object Area -Descending | Select-Object -First 1
}
if ($null -eq $target) {
  $target = $candidates | Where-Object { $_.Title -like '*DeepSeek Harness*' } | Sort-Object Area -Descending | Select-Object -First 1
}

if ($null -eq $target) {
  [pscustomobject]@{ ok = $false; error = 'window-not-found'; pid = $TargetPid } | ConvertTo-Json -Compress
  exit 0
}

$hwnd = $target.Hwnd
$before = ([DshWin32]::GetWindowLongPtr($hwnd, $GWL_EXSTYLE).ToInt64() -band $WS_EX_TOPMOST) -ne 0
$want = $before
switch ($Action) {
  'status' { $want = $before }
  'on' { $want = $true }
  'off' { $want = $false }
  'toggle' { $want = -not $before }
}

$apiOk = $true
if ($want -ne $before) {
  $insertAfter = if ($want) { $HWND_TOPMOST } else { $HWND_NOTOPMOST }
  $flags = [uint32]($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE)
  $apiOk = [DshWin32]::SetWindowPos($hwnd, $insertAfter, 0, 0, 0, 0, $flags)
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

$after = ([DshWin32]::GetWindowLongPtr($hwnd, $GWL_EXSTYLE).ToInt64() -band $WS_EX_TOPMOST) -ne 0

[pscustomobject]@{
  ok = $apiOk
  action = $Action
  hwnd = $hwnd.ToInt64()
  pid = $target.Pid
  title = $target.Title
  before = $before
  topmost = $after
  win32error = if ($want -ne $before -and -not $apiOk) { $err } else { 0 }
} | ConvertTo-Json -Compress
