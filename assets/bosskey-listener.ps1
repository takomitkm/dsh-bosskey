# bosskey-listener.ps1 —— dsh-bosskey 热键监听器(独立进程)。
#
# RegisterHotKey 注册全局热键 -> 触发时判断 DeepSeek Harness 主窗口状态:
#   可见且前台 -> 按 hideWhenForeground 决定是否 SW_HIDE(外置隐藏,账面错位由唤醒半边兜)
#   其他状态   -> 洗净 ELECTRON_RUN_AS_NODE 后启动 exe "dsh://open"(壳官方唤起路径)
# 并把动作 POST 回 Host 的回环 HTTP(带 token)。
#
# 已知坑(来自 dsh-screenshot / dsh-taskbox 的踩坑记录):
# - param() 必须在第一行(无 BOM UTF-8 下 PS 5.1 会吞中文注释行尾);
# - RegisterHotKey 场景下不要用 PowerShell 事件,用 C# GetMessage 循环;
# - 退出码:正常退出 0,参数错 2,注册失败 3。

param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][int]$HkMod,
  [Parameter(Mandatory = $true)][int]$HkVk
)
$ErrorActionPreference = 'Stop'

if (-not ('BkNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class BkNative {
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern IntPtr GetMessage(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }
  [DllImport("user32.dll")] public static extern int GetMessageW(out MSG m, IntPtr w, uint f, uint l);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  public static List<IntPtr> WindowsOfPid(uint target) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static IntPtr FindDshMainHwnd() {
    foreach (var p in System.Diagnostics.Process.GetProcesses()) {
      try {
        var pn = p.ProcessName ?? "";
        if (!(pn.StartsWith("DeepSeek", StringComparison.OrdinalIgnoreCase))) continue;
        foreach (IntPtr h in WindowsOfPid((uint)p.Id)) {
          var sb = new StringBuilder(512);
          GetWindowText(h, sb, 512);
          string t = sb.ToString();
          if (IsWindowVisible(h) && t.Contains("DeepSeek Harness")) return h;
        }
      } catch { }
    }
    return IntPtr.Zero;
  }
}
"@ -ErrorAction Stop
}

function Write-Log([string]$msg) {
  try {
    $dir = if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { Join-Path $env:DSH_HOME.Trim() 'bosskey' } else { Join-Path $env:USERPROFILE '.dsh\bosskey' }
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::AppendAllText((Join-Path $dir 'listener.log'), ("[{0}] {1}`n" -f (Get-Date -Format o), $msg), [System.Text.Encoding]::UTF8)
  } catch { }
}

function Post-Trigger([hashtable]$body) {
  try {
    $json = $body | ConvertTo-Json -Compress
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/trigger")
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $req.Headers.Add('x-bosskey-token', $Token)
    $req.Timeout = 2000
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $s = $req.GetRequestStream()
    $s.Write($bytes, 0, $bytes.Length)
    $s.Close()
    $resp = $req.GetResponse()
    $resp.Close()
    return $true
  } catch {
    Write-Log "post trigger failed: $($_.Exception.Message)"
    return $false
  }
}

function Get-FreshConfig {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/config")
    $req.Headers.Add('x-bosskey-token', $Token)
    $req.Timeout = 2000
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $text = $sr.ReadToEnd()
    $sr.Close(); $resp.Close()
    return $text | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Find-DshExe {
  $local = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
  if (Test-Path $local) { return $local }
  return $null
}

function Invoke-Wake {
  # 洗净 ELECTRON_RUN_AS_NODE:它会让 exe 退化成纯 Node,把 dsh://open 当模块路径崩掉
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $exe = Find-DshExe
  if ($exe) {
    $psi.FileName = $exe
    $psi.Arguments = 'dsh://open'
  } else {
    # 无 exe 可用:走协议(注意同样要洗环境,ShellExecute 会继承)
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -Command ""Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process 'dsh://open'"""
    $psi.UseShellExecute = $false
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  try {
    if ($psi.EnvironmentVariables.ContainsKey('ELECTRON_RUN_AS_NODE')) { $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') }
  } catch { }
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Invoke-BossToggle {
  $cfg = Get-FreshConfig
  $hide = $true
  if ($cfg -and ($cfg.hideWhenForeground -eq $false)) { $hide = $false }

  $hwnd = [BkNative]::FindDshMainHwnd()
  if ($hwnd -eq [IntPtr]::Zero) {
    # 窗口不可见(托盘里/最小化藏起):唤回
    Write-Log 'toggle: hidden -> wake via dsh://open'
    Invoke-Wake
    [void](Post-Trigger @{ action = 'wake'; detail = 'window was hidden' })
    return
  }
  $fg = [BkNative]::GetForegroundWindow()
  $fgPid = 0
  [void][BkNative]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $hwndPid = 0
  [void][BkNative]::GetWindowThreadProcessId($hwnd, [ref]$hwndPid)
  if ($fgPid -eq $hwndPid) {
    # 已是前台:按配置决定是否外置隐藏
    if ($hide) {
      [void][BkNative]::ShowWindow($hwnd, 0)  # SW_HIDE
      Write-Log 'toggle: foreground -> SW_HIDE'
      [void](Post-Trigger @{ action = 'hide'; detail = ('hwnd=0x{0:X}' -f $hwnd.ToInt64()) })
    } else {
      Write-Log 'toggle: foreground -> hideWhenForeground=false, no-op'
      [void](Post-Trigger @{ action = 'noop'; detail = 'hideWhenForeground=false' })
    }
  } else {
    # 可见但不在前台:唤起置前
    Write-Log 'toggle: visible-not-foreground -> wake via dsh://open'
    Invoke-Wake
    [void](Post-Trigger @{ action = 'wake'; detail = 'window was visible but not foreground' })
  }
}

# ---------------- 主循环 ----------------
Write-Log ('listener start port={0} mod=0x{1:X} vk=0x{2:X}' -f $Port, $HkMod, $HkVk)
if (-not [BkNative]::RegisterHotKey([IntPtr]::Zero, 0xB055, [uint32]$HkMod, [uint32]$HkVk)) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Log "RegisterHotKey failed win32err=$err (conflict?)"
  [void](Post-Trigger @{ action = 'register-failed'; detail = "win32err=$err" })
  exit 3
}
Write-Log 'RegisterHotKey ok'

$msg = New-Object BkNative+MSG
while ($true) {
  $r = [BkNative]::GetMessageW([ref]$msg, [IntPtr]::Zero, 0, 0)
  if ($r -le 0) { break }
  if ($msg.message -eq 0x0312 -and $msg.wParam -eq [IntPtr]0xB055) {  # WM_HOTKEY
    try { Invoke-BossToggle } catch { Write-Log "toggle failed: $($_.Exception.Message)" }
  }
}
[void][BkNative]::UnregisterHotKey([IntPtr]::Zero, 0xB055)
Write-Log 'listener exit'
exit 0
