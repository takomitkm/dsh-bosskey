# bosskey-conflict-dialog.ps1 —— dsh://bosskey/conflict 冲突检测对话框(独立短命进程)。
#
# PowerToys 式试探的交互壳:用户在文本框输入组合键(如 Ctrl+Alt+K),点「检测」,
# 进程内 RegisterHotKey(nullptr, testId, mod, vk) 试注册:
#   失败 + ERROR_HOTKEY_ALREADY_REGISTERED = 系统/其他应用占用
#   成功 = 立即 Unregister,报告可用
# 由 dsh://bosskey/conflict 协议启动(dsh-bosskey Host 半区识别 argv)。
# param() 必须第一行;文件需 UTF-8 BOM。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

if (-not ('BkConflictUi' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BkConflictUi {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
}
"@
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'dsh-bosskey 快捷键冲突检测'
$form.Size = New-Object System.Drawing.Size(460, 220)
$form.FormBorderStyle = 'FixedDialog'
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = '输入要检测的组合键(如 Ctrl+Alt+K、F9):'
$label.Location = New-Object System.Drawing.Point(12, 12)
$label.AutoSize = $true
$form.Controls.Add($label)

$input = New-Object System.Windows.Forms.TextBox
$input.Location = New-Object System.Drawing.Point(12, 36)
$input.Size = New-Object System.Drawing.Size(300, 23)
$form.Controls.Add($input)

$button = New-Object System.Windows.Forms.Button
$button.Text = '检测'
$button.Location = New-Object System.Drawing.Point(320, 34)
$button.Size = New-Object System.Drawing.Size(110, 26)
$form.Controls.Add($button)

$output = New-Object System.Windows.Forms.Label
$output.Location = New-Object System.Drawing.Point(12, 70)
$output.Size = New-Object System.Drawing.Size(420, 90)
$form.Controls.Add($output)

function Get-VkForChar([string]$key) {
  $vk = [System.Windows.Forms.Keys]::None
  if ([System.Enum]::TryParse([System.Windows.Forms.Keys], $key, [ref]$vk)) { return [int]$vk }
  if ($key.Length -eq 1) {
    $ch = [char]::ToUpper($key[0])
    if ($ch -ge 'A' -and $ch -le 'Z') { return [int][char]$ch }
    if ($ch -ge '0' -and $ch -le '9') { return [int][char]$ch }
  }
  return -1
}

function Test-Combination([string]$text) {
  $parts = $text.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $mod = 0
  $vk = -1
  foreach ($part in $parts) {
    switch ($part.ToLower()) {
      'ctrl' { $mod = $mod -bor 0x2; continue }
      'control' { $mod = $mod -bor 0x2; continue }
      'alt' { $mod = $mod -bor 0x1; continue }
      'shift' { $mod = $mod -bor 0x4; continue }
      'win' { $mod = $mod -bor 0x8; continue }
      'windows' { $mod = $mod -bor 0x8; continue }
    }
    if ($vk -eq -1) { $vk = Get-VkForChar $part } else { return $null }
  }
  if ($vk -eq -1) { return $null }
  return @{ Mod = $mod; Vk = $vk }
}

$button.Add_Click({
  $parsed = Test-Combination $input.Text
  if ($null -eq $parsed) {
    $output.Text = '无法解析组合键。示例:Ctrl+Alt+K、F9、Win+D。'
    return
  }
  $TEST_ID = 0x0FFF
  $ok = [BkConflictUi]::RegisterHotKey([IntPtr]::Zero, $TEST_ID, [uint32]$parsed.Mod, [uint32]$parsed.Vk)
  if ($ok) {
    [void][BkConflictUi]::UnregisterHotKey([IntPtr]::Zero, $TEST_ID)
    $output.Text = "✅ 可用:`"$($input.Text)`" 当前没有被系统或其他应用占用。`n(注意:占用关系是动态的,以实际使用为准)"
  } else {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $reason = if ($err -eq 1409) { '已被系统或其他应用注册' } else { "RegisterHotKey 失败 (win32err=$err)" }
    $output.Text = "❌ 冲突:`"$($input.Text)`" $reason。`n换一个组合再试。"
  }
})
$input.Add_KeyDown({
  if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) { $button.PerformClick() }
})

$form.Add_Shown({ $input.Focus() })
[void]$form.ShowDialog()
