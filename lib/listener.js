/**
 * listener.js —— 热键监听器进程管理。
 *
 * Host 插件是普通 Node 进程,没有消息循环,收不了 Win32 热键;所以拉起一个隐藏的
 * PowerShell 进程 RegisterHotKey,热键触发后 POST 给 Host 的回环 HTTP。
 *
 * 设计约束(沿用 dsh-taskbox 的坑位经验):
 * - stdout/stderr 接文件描述符,不用管道(沙箱限制的进程里管道会 EPERM);
 * - 连续失败退避 5s/15s/60s/300s,满 5 次放弃,不刷爆日志;
 * - Host 退出时杀子进程;监听器崩溃由心跳重拉;
 * - 换键 = 先 kill 旧进程再起新进程,失败回滚到旧键继续跑。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_LOG_BYTES = 256 * 1024
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000]
const MAX_FAILURES = 5

export class HotkeyListener {
  /**
   * @param {object} deps `{ logger, port, token, scriptPath, logPath }`
   */
  constructor(deps) {
    this.log = deps.logger ?? (() => {})
    this.port = deps.port
    this.token = deps.token
    this.scriptPath = deps.scriptPath
    this.logPath = deps.logPath
    this.child = null
    this.currentHotkey = null
    this.startedAt = 0
    this.failures = 0
    this.nextRetryAt = 0
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed)
  }

  get canRetry() {
    if (this.failures >= MAX_FAILURES) return false
    return Date.now() >= this.nextRetryAt
  }

  /** 起一个监听指定热键的进程;已在跑同款则不动。返回是否(重新)拉起。 */
  start(hotkey) {
    if (this.running && this.currentHotkey === hotkey.label) return false
    if (this.running) this.stop() // 换键:先停旧的
    if (!this.canRetry) {
      if (this.failures >= MAX_FAILURES) this.log(`listener disabled after repeated failures (hotkey=${hotkey.label})`)
      return false
    }
    let fd = null
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      this.#rotateLog(this.logPath)
      this.#appendRaw(this.logPath, `\n===== ${new Date().toISOString()} spawn hotkey=${hotkey.label} mod=${hotkey.mod} vk=${hotkey.vk} =====\n`)
      fd = openSync(this.logPath, 'a')
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-STA',
          '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
          '-File', this.scriptPath,
          '-Port', String(this.port),
          '-Token', String(this.token),
          '-HkMod', String(hotkey.mod),
          '-HkVk', String(hotkey.vk),
        ],
        { windowsHide: true, stdio: ['ignore', fd, fd], detached: false },
      )
      this.child = child
      this.currentHotkey = hotkey.label
      this.startedAt = Date.now()
      child.on('error', (err) => {
        this.log('listener spawn error', err)
        this.#appendRaw(this.logPath, `[spawn-error] ${String(err?.message ?? err)}\n`)
        if (this.child === child) this.child = null
        this.#noteFailure(`spawn: ${String(err?.message ?? err)}`)
      })
      child.on('exit', (code, signal) => {
        this.#appendRaw(this.logPath, `[exit] code=${code} signal=${signal} after ${Date.now() - this.startedAt}ms\n`)
        if (this.child === child) this.child = null
        // 活过 3s 算正常退出(用户注销/系统关热键冲突等),退避清零
        if (Date.now() - this.startedAt > 3000) {
          this.failures = 0
          this.nextRetryAt = 0
          return
        }
        this.#noteFailure(`exit code=${code}`)
      })
      this.log(`listener spawned pid=${child.pid} hotkey=${hotkey.label}`)
      return true
    } catch (err) {
      this.log('listener start failed', err)
      try { this.#appendRaw(this.logPath, `[start-failed] ${String(err?.message ?? err)}\n`) } catch { /* 忽略 */ }
      this.child = null
      this.#noteFailure(`start: ${String(err?.message ?? err)}`)
      return false
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* 子进程已持有句柄 */ }
      }
    }
  }

  stop() {
    const child = this.child
    if (!child) return
    this.child = null
    this.currentHotkey = null
    try {
      if (child.exitCode === null) child.kill()
    } catch (err) {
      this.log('listener stop failed', err)
    }
  }

  tailLog(lines = 40) {
    try {
      const raw = readFileSync(this.logPath, 'utf8')
      return raw.split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  /** 把当前生效热键落盘(排障/自检用)。 */
  persistActive(dir, hotkey) {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'active.json'), JSON.stringify({ hotkey: hotkey.label, mod: hotkey.mod, vk: hotkey.vk, pid: this.child?.pid ?? null, since: Date.now() }, null, 2), 'utf8')
    } catch { /* 不影响主流程 */ }
  }

  #noteFailure(reason) {
    this.failures += 1
    const wait = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)]
    this.nextRetryAt = Date.now() + wait
    this.log(`listener start failed (${this.failures}/${MAX_FAILURES}): ${reason}; retry in ${Math.round(wait / 1000)}s`)
  }

  #rotateLog(path) {
    try {
      const st = readFileSync(path)
      if (st.length > MAX_LOG_BYTES) writeFileSync(path, '', 'utf8')
    } catch { /* 文件还不存在 */ }
  }

  #appendRaw(path, text) {
    try {
      appendFileSync(path, text, 'utf8')
    } catch { /* 日志失败不影响主流程 */ }
  }
}
