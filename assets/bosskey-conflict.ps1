# bosskey-conflict.ps1 —— 快捷键系统占用试探(独立短命进程)。
#
# 移植自 PowerToys src/runner/hotkey_conflict_detector.cpp 的
# HasConflictWithSystemHotkey:用 RegisterHotKey(nullptr, testId, mod, vk) 试注册,
# 失败且 GetLastError()==ERROR_HOTKEY_ALREADY_REGISTERED 即系统/其他应用占用;
# 成功则立即 Unregister 并报可用。试探用固定测试 ID(0x0FFF),与监听器的
# 0xB055 不冲突;试探瞬间完成,不影响真实监听器。
#
# 输出(供调用方解析):单行 JSON
#   {"available": bool, "win32err": int|null, "label": "Ctrl+Alt+K"}
#
# param() 必须第一行;文件需 UTF-8 BOM。

param(
  [Parameter(Mandatory = $true)][int]$HkMod,
  [Parameter(Mandatory = $true)][int]$HkVk,
  [Parameter(Mandatory = $false)][string]$Label = ''
)

$ErrorActionPreference = 'Stop'

if (-not ('BkConflict' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BkConflict {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mod, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
}
"@
}

$TEST_ID = 0x0FFF   # PowerToys 同款:临时试探专用 ID
$MOD_WIN = 0x8; $MOD_CTRL = 0x2; $MOD_SHIFT = 0x4; $MOD_ALT = 0x1

# 无修饰键的组合在 RegisterHotKey 语义下本来就不合法(PowerToys 同样直接判可用),
# 这类键由调用方自行决定意义(如 F9 这类功能键是合法热键,这里照报可用)。
$result = [ordered]@{ available = $true; win32err = $null; label = $Label }
$ok = [BkConflict]::RegisterHotKey([IntPtr]::Zero, $TEST_ID, [uint32]$HkMod, [uint32]$HkVk)
if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $result.available = $false
  $result.win32err = $err
} else {
  [void][BkConflict]::UnregisterHotKey([IntPtr]::Zero, $TEST_ID)
}
$result | ConvertTo-Json -Compress
