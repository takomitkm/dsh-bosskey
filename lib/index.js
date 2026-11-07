/**
 * dsh-bosskey —— Host 半区入口。
 *
 * 一键 Boss 键:热键触发 → 主窗口可见且前台时隐藏,否则经壳的官方 dsh://open 通道唤回
 * (second-instance → focusPrimaryWindow,输入必然正常,不走外部 ShowWindow 硬显示)。
 *
 * 隐藏半边说明:Host 拿不到 BrowserWindow,只能外置 ShowWindow(SW_HIDE)。
 * 实测(2026-11-07)隐藏后壳账面仍是"可见",但 dsh://open 唤回能恢复 visible 且前台夺回;
 * 渲染进程输入正常性是首要验收项,如发现隐藏态输入异常,把 config.hideWhenForeground
 * 改为 false 即降级为"唤起-only"(再按不藏,只置前)。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, readFileSync as readFs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_HOTKEY, parseHotkey, stateDir } from './state.js'
import { HotkeyListener } from './listener.js'

export const name = 'dsh-bosskey'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LISTENER_SCRIPT = join(PKG_ROOT, 'assets', 'bosskey-listener.ps1')
const LOG_MAX_BYTES = 256 * 1024

/** 环境变量开关(不引入 Config,减少激活期失败面)。 */
function envFlag(key, fallback) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  return !/^(0|false|off|no)$/i.test(raw.trim())
}

function makeLogger(dir) {
  const path = join(dir, 'host.log')
  let last = 0
  return (...args) => {
    const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safeJson(a))).join(' ')
    if (process.env.DSH_BOSSKEY_DEBUG) console.log('[dsh-bosskey]', text)
    const now = Date.now()
    if (now - last < 50) return
    last = now
    try {
      mkdirSync(dir, { recursive: true })
      try {
        if (readFs(path).length > LOG_MAX_BYTES) writeFileSync(path, '', 'utf8')
      } catch { /* 首次 */ }
      appendFileSync(path, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
    } catch { /* 日志失败不影响主流程 */ }
  }
}

function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** 配置读写:hotkey 字符串 + hideWhenForeground 开关。 */
function loadConfig(dir) {
  const fallback = { hotkey: DEFAULT_HOTKEY, hideWhenForeground: true }
  try {
    const raw = readFileSync(join(dir, 'config.json'), 'utf8')
    const doc = JSON.parse(raw)
    return {
      hotkey: typeof doc.hotkey === 'string' && doc.hotkey.trim() ? doc.hotkey.trim() : fallback.hotkey,
      hideWhenForeground: doc.hideWhenForeground === undefined ? fallback.hideWhenForeground : Boolean(doc.hideWhenForeground),
    }
  } catch {
    return fallback
  }
}

function exeCandidate() {
  // 桌面壳 exe;协议方式(Start-Process 'dsh://open')作为兜底,但 ShellExecute 会继承
  // 发射进程环境,若环境里有 ELECTRON_RUN_AS_NODE 协议路径也会崩,所以监听器里两条路都洗净环境。
  const local = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
  return local
}

export function apply(ctx) {
  const dir = stateDir()
  const log = makeLogger(dir)
  try {
    boot(ctx, log, dir)
  } catch (err) {
    log('boot failed', err)
    console.error('[dsh-bosskey] boot failed:', err)
  }
}

function boot(ctx, log, dir) {
  mkdirSync(dir, { recursive: true })
  let config = loadConfig(dir)
  let listener = null
  let serverRef = null
  let lastTriggerAt = 0

  /** 热键动作:前台且可见 → 可选隐藏;否则唤回。全部委托给监听器进程执行窗口判定,
   *  Host 只收「boss-toggle」通知并记录。 */
  async function onToggle(payload) {
    lastTriggerAt = Date.now()
    const action = String(payload?.action ?? '?')
    log(`hotkey fired -> ${action}`, payload?.detail ?? '')
    try {
      writeFileSync(join(dir, 'last-trigger.json'), JSON.stringify({ at: lastTriggerAt, action, detail: payload?.detail ?? null }, null, 2), 'utf8')
    } catch { /* 不影响主流程 */ }
    return { ok: true }
  }

  // ---------------- 本地回环 HTTP:监听器 → Host ----------------
  const token = randomBytes(16).toString('hex')
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const supplied = req.headers['x-bosskey-token'] ?? url.searchParams.get('t') ?? ''
      const a = Buffer.from(String(token), 'utf8')
      const b = Buffer.from(String(supplied), 'utf8')
      const authed = a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
      if (!authed) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/ping') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, hotkey: listener?.currentHotkey ?? null, hideWhenForeground: config.hideWhenForeground }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/config') {
        // 监听器每次触发都拉一次最新配置(改键/改开关不用重启)
        const fresh = loadConfig(dir)
        if (fresh.hotkey !== config.hotkey || fresh.hideWhenForeground !== config.hideWhenForeground) {
          config = fresh
          armListener(true)
        }
        const parsed = parseHotkey(config.hotkey)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, hotkey: parsed?.label ?? null, mod: parsed?.mod ?? null, vk: parsed?.vk ?? null, hideWhenForeground: config.hideWhenForeground }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/trigger') {
        let body = ''
        req.on('data', (c) => { body += c })
        await new Promise((resolve) => req.on('end', resolve))
        let payload = {}
        try { payload = body ? JSON.parse(body) : {} } catch { payload = {} }
        const result = await onToggle(payload)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (err) {
      log('http request failed', err)
      try {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
      } catch { /* 连接已断 */ }
    }
  })

  function armListener(force = false) {
    try {
      const parsed = parseHotkey(config.hotkey)
      if (!parsed) {
        log(`invalid hotkey in config: '${config.hotkey}' (keep listening with previous)`)
        if (!listener?.running) armFallbackListener()
        return
      }
      listener.persistActive(dir, parsed)
      const started = listener.start(parsed)
      if (force && !started && !listener.running) armFallbackListener()
    } catch (err) {
      log('armListener failed', err)
    }
  }

  /** 热键注册失败(冲突/权限)的兜底:注册一个仅上报冲突的热键位不占坑会失败,
   *  这里退化为「无热键模式」——只保留 /command 通道,用户仍可用 DSH 命令 boss 唤回。 */
  function armFallbackListener() {
    log('listener not running; boss command still available')
  }

  /** `dsh://bosskey/status`:client-shortcuts 设置页的「打开状态页」按钮走协议拉起
   *  本插件一次;协议启动的实例不抢单实例锁的所有权(second-instance 通知第一实例
   *  唤窗),但 Windows 上协议处理器会真的启动新进程,所以这里独立判断参数,弹出
   *  一个原生 MessageBox 展示 active.json 快照(热键/开关/生效时间)。 */
  function maybeShowStatusFromArgv() {
    try {
      const argv = process.argv.join(' ')
      if (!/dsh:\/\/bosskey\/status/i.test(argv)) return
      const ps = join(PKG_ROOT, 'assets', 'bosskey-status.ps1')
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      log('status dialog requested via dsh://bosskey/status')
    } catch (err) {
      log('status dialog spawn failed', err)
    }
  }
  maybeShowStatusFromArgv()

  ctx.effect(() => {
    let disposed = false
    server.listen(0, '127.0.0.1', () => {
      if (disposed) {
        server.close()
        return
      }
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      serverRef = { port }
      log(`local server on 127.0.0.1:${port}`)
      try {
        writeFileSync(join(dir, 'server.json'), JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }, null, 2), 'utf8')
      } catch (err) { log('write server.json failed', err) }
      listener = new HotkeyListener({ logger: log, port, token, scriptPath: LISTENER_SCRIPT, logPath: join(dir, 'listener.log') })
      armListener()
    })
    return () => {
      disposed = true
      try { listener?.stop() } catch { /* 忽略 */ }
      try { server.close() } catch { /* 忽略 */ }
      try { rmSync(join(dir, 'server.json'), { force: true }) } catch { /* 忽略 */ }
    }
  })

  // ---------------- 心跳:监听器意外退出重拉 ----------------
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        if (!listener || listener.running || !listener.canRetry) return
        const parsed = parseHotkey(config.hotkey)
        if (parsed) listener.start(parsed)
      } catch (err) {
        log('tick failed', err)
      }
    }, 3000)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  // ---------------- DSH 命令:/boss ----------------
  try {
    ctx.inject(['commands'], (injected) => {
      injected.effect(() => injected.commands.register({
        name: 'boss',
        description: 'Boss 键:立即唤回 DeepSeek Harness 主窗口(等效按一次热键的唤起半边)',
        input: { hint: '（无需参数）' },
        handler: () => {
          try {
            const exe = exeCandidate()
            const cleanEnv = { ...process.env }
            delete cleanEnv.ELECTRON_RUN_AS_NODE
            if (existsSync(exe)) {
              spawn(exe, ['dsh://open'], { detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv }).unref()
              return { kind: 'success', text: '已请求唤回主窗口' }
            }
            spawn('powershell.exe', ['-NoProfile', '-Command', "Start-Process 'dsh://open'"], { detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv }).unref()
            return { kind: 'success', text: '已通过协议请求唤回主窗口' }
          } catch (err) {
            return { kind: 'error', text: `唤回失败:${String(err?.message ?? err)}` }
          }
        },
      }))
    })
  } catch (err) {
    log('commands inject unavailable', err)
  }

  log(`booted (hotkey=${config.hotkey} hideWhenForeground=${config.hideWhenForeground})`)
}
