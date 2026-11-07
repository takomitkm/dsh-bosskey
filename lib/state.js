/**
 * state.js —— 配置与状态目录。
 *
 * 配置文件:$DSH_HOME/bosskey/config.json
 *   { "hotkey": "F9", "hideWhenForeground": true }
 * 修改后不用重启 DSH:监听器进程每次热键触发都会问 Host 要最新配置;
 * 换键走「杀旧监听器、起新监听器」。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_HOTKEY = 'F9'

/** `$DSH_HOME/bosskey`(跟随 DSH_HOME 环境变量,缺省 `~/.dsh`)。 */
export function stateDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, 'bosskey')
}

/** 解析 "Ctrl+Alt+D" 形式的热键串 → Win32 修饰键/虚键码;不合法返回 null。 */
export function parseHotkey(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 5) return null
  let mod = 0
  let vk = 0
  for (const part of parts) {
    const key = part.toLowerCase()
    if (key === 'ctrl' || key === 'control') mod |= 0x0002
    else if (key === 'alt') mod |= 0x0001
    else if (key === 'shift') mod |= 0x0004
    else if (key === 'win' || key === 'meta') mod |= 0x0008
    else {
      const vk2 = keyCodeOf(part)
      if (!vk2) return null
      if (vk) return null // 两个非修饰键
      vk = vk2
    }
  }
  if (!vk) return null
  return { mod, vk, label: normalizeLabel(mod, vk) }
}

function normalizeLabel(mod, vk) {
  const mods = []
  if (mod & 0x0008) mods.push('Win')
  if (mod & 0x0002) mods.push('Ctrl')
  if (mod & 0x0004) mods.push('Shift')
  if (mod & 0x0001) mods.push('Alt')
  return `${mods.join('+')}+${keyNameOf(vk)}`
}

const VK_MAP = {
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48, I: 0x49,
  J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d, N: 0x4e, O: 0x4f, P: 0x50, Q: 0x51, R: 0x52,
  S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58, Y: 0x59, Z: 0x5a,
  0: 0x30, 1: 0x31, 2: 0x32, 3: 0x33, 4: 0x34, 5: 0x35, 6: 0x36, 7: 0x37, 8: 0x38, 9: 0x39,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77,
  F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
  SPACE: 0x20, ESC: 0x1b, ESCAPE: 0x1b, TAB: 0x09, ENTER: 0x0d, RETURN: 0x0d,
  BACKSPACE: 0x08, DELETE: 0x2e, INSERT: 0x2d, HOME: 0x24, END: 0x23,
  PAGEUP: 0x21, PAGEDOWN: 0x22, PRINTSCREEN: 0x2c, SCROLLLOCK: 0x91, PAUSE: 0x13,
  '`': 0xc0, '~': 0xc0, ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, "'": 0xde,
  '[': 0xdb, ']': 0xdd, '\\': 0xdc, '-': 0xbd, '=': 0xbb,
}

function keyCodeOf(part) {
  const key = part.toUpperCase()
  if (Object.hasOwn(VK_MAP, key)) return VK_MAP[key]
  if (/^NUM[0-9]$/.test(key)) return 0x60 + Number(key.slice(3))
  return null
}

function keyNameOf(vk) {
  for (const [name, code] of Object.entries(VK_MAP)) {
    if (code === vk) return name === '~' ? '`' : name
  }
  return `0x${vk.toString(16)}`
}
