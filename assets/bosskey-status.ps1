# bosskey-status.ps1 —— dsh://bosskey/status 状态对话框(独立短命进程)。
#
# 由 dsh-bosskey 的 Host 半区在协议启动(参数含 dsh://bosskey/status)时拉起:
# 读 $DSH_HOME/bosskey/active.json 快照 + config.json,弹一个原生 MessageBox。
# param() 必须第一行(无 BOM UTF-8 下 PS 5.1 吞中文注释行尾);文件需 UTF-8 BOM。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$dir = if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { Join-Path $env:DSH_HOME.Trim() 'bosskey' } else { Join-Path $env:USERPROFILE '.dsh\bosskey' }

$hotkey = '未注册(监听器未运行?)'
$since = '-'
try {
  $active = Get-Content (Join-Path $dir 'active.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($active.hotkey) { $hotkey = $active.hotkey }
  if ($active.since) { $since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$active.since).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss') }
} catch { }

$hide = 'true(前台时隐藏)'
try {
  $cfg = Get-Content (Join-Path $dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.hideWhenForeground -eq $false) { $hide = 'false(只唤起不隐藏)' }
} catch { }

$text = "dsh-bosskey 监听器状态`n`n  当前热键:  $hotkey`n  前台隐藏:  $hide`n  生效时间:  $since`n`n完整 toggle:前台时按=隐藏,后台时按=唤回。`n改键:编辑 $dir\config.json 后按一次热键即生效。"
$icon = [System.Windows.Forms.MessageBoxIcon]::Information
[void][System.Windows.Forms.MessageBox]::Show($text, 'dsh-bosskey', [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
