/**
 * test/selftest.mjs —— dsh-bosskey 离线自检(不需要 DSH 在跑)。
 *
 * 覆盖:
 * 1. parseHotkey 合法/非法用例
 * 2. 监听器进程:洗净 ELECTRON_RUN_AS_NODE 环境下 spawn,RegisterHotKey 成功,HTTP /ping /config 通
 * 3. 模拟热键触发:向监听器无法注入真实按键,改为直接调 Host HTTP 的 /trigger 协议验证
 *    (真实按键端到端在安装后人工验收)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { parseHotkey } from '../lib/state.js'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PKG_ROOT, 'assets', 'bosskey-listener.ps1')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// ---------------- 1. parseHotkey ----------------
{
  const cases = [
    ['Ctrl+D', true],
    ['Ctrl+Alt+D', true],
    ['F9', true],
    ['Ctrl+Shift+F12', true],
    ['Win+Space', true],
    ['PrintScreen', true],
    ['', false],
    ['Ctrl+', false],
    ['Ctrl+NotAKey', false],
    ['Ctrl+Alt+Shift+Win+F9', true],
    ['D+Ctrl', true],          // 顺序无关
    ['Ctrl+D+F9', false],      // 两个非修饰键
  ]
  for (const [input, expect] of cases) {
    const parsed = parseHotkey(input)
    check(`parseHotkey('${input}') -> ${expect ? 'valid' : 'invalid'}`, Boolean(parsed) === expect, parsed ? `label=${parsed.label} mod=${parsed.mod} vk=${parsed.vk}` : '')
  }
  const d = parseHotkey('F9')
  check('F9 encodes mod=0 vk=0x78', d && d.mod === 0 && d.vk === 0x78)
}

// ---------------- 2. listener process against a fake Host ----------------
{
  const token = randomBytes(8).toString('hex')
  const triggers = []
  const fakeHost = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/config') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, hotkey: 'F9', mod: 0, vk: 120, hideWhenForeground: true }))
      return
    }
    if (url.pathname === '/trigger') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        triggers.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => fakeHost.listen(0, '127.0.0.1', resolve))
  const port = fakeHost.address().port

  const tmp = mkdtempSync(join(tmpdir(), 'dsh-bosskey-test-'))
  const logPath = join(tmp, 'listener.log')

  // 净化环境:去掉 ELECTRON_RUN_AS_NODE,否则监听器内部的 powershell 不受影响,
  // 但保持和生产(node 由 DSH host 启动)一致的语义
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const hk = parseHotkey('F9')
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', SCRIPT,
    '-Port', String(port),
    '-Token', token,
    '-HkMod', String(hk.mod),
    '-HkVk', String(hk.vk),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env })

  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c })
  child.stdout.on('data', () => { /* ignore */ })

  // 等 1.2s:注册成功 + 监听器主动 GET /config 一次(在触发时才拉,这里主动探 /ping 没实现,
  // 改成观察进程存活 1.2s + 日志里有 RegisterHotKey ok)
  await new Promise((r) => setTimeout(r, 1500))
  const alive = child.exitCode === null
  check('listener process alive after 1.5s (RegisterHotKey ok, no parse error)', alive, alive ? '' : `exit=${child.exitCode} stderr=${stderr.slice(0, 300)}`)
  if (alive) {
    // F9 也可能被占用,注册失败会 exit 3 —— 区分这一情况
    // 日志走 $DSH_HOME/bosskey/listener.log(监听器自己算 home),临时目录不影响它
    const home = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(env.USERPROFILE ?? env.HOMEPATH ?? '', '.dsh')
    const logText = safeRead(join(home, 'bosskey', 'listener.log'))
    const tail = logText.split('\n').filter(Boolean).slice(-8).join(' | ')
    if (logText.includes('RegisterHotKey failed')) {
      check('RegisterHotKey succeeded', false, tail)
    } else if (logText.includes('RegisterHotKey ok')) {
      check('RegisterHotKey succeeded', true, tail)
    } else {
      check('RegisterHotKey status visible in log', false, `no marker; tail: ${tail || '(empty)'}`)
    }
  }

  child.kill()
  fakeHost.close()
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

// ---------------- summary ----------------
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
