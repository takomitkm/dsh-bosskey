# dsh-bosskey

DSH(DeepSeek Harness)桌面端插件:**全局 Boss 键**。任意应用前台时按热键(默认 `F9`,可自定义),一键隐藏/唤回 DeepSeek Harness 主窗口——回应 [deepseek-harness#8749](https://github.com/deepseek-ai/deepseek-harness/discussions/8749) 需求一。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

## 功能

默认热键 `F9`(可自定义,见下文):

| 场景 | 行为 |
|---|---|
| DSH 主窗口可见且前台 | 隐藏到后台(`hideWhenForeground: true` 时;`false` 则不隐藏,只保留唤起) |
| DSH 主窗口可见但被遮挡 | 唤回前台 |
| DSH 主窗口已隐藏/最小化 | 唤回前台(同一 hwnd,恢复会话、草稿、滚动位置) |

热键在**任意应用**下全局生效,包括游戏全屏(非独占)。

## 安装

前置:Windows 10/11 + DSH 桌面端,PowerShell 5.1(系统自带,无需额外运行时)。

```powershell
dsh plugin --profile desktop add link:S:\apps\llm\agentwork\dsh-bosskey
```

或从 npm/Git(发布后):

```powershell
dsh plugin --profile desktop add dsh-bosskey
```

装完**完全退出桌面端(含托盘)再打开**。

## 自定义热键

编辑 `%USERPROFILE%\.dsh\bosskey\config.json`(没有就建一个):

```json
{ "hotkey": "Ctrl+Alt+D", "hideWhenForeground": true }
```

- 格式:`修饰键+主键`,修饰键支持 `Ctrl` / `Alt` / `Shift` / `Win`(顺序无关,如 `D+Ctrl` 等价 `Ctrl+D`);主键支持 `A-Z`、`0-9`、`F1-F12`、`Space`、`PrintScreen` 等
- **改动即时生效,不用重启**:监听器每次热键触发都会从 Host 拉最新配置并自动换键
- 主键被其他应用占用时注册失败,插件自动降级为"仅命令模式",`host.log` 里留 `RegisterHotKey failed` 记录

## 使用

- 按热键:如上表切换显隐
- DSH 里输入 `/boss`:等效"唤起半边"(不切换,只把主窗口唤回)
- 状态排查:`%USERPROFILE%\.dsh\bosskey\` 下 `host.log`(Host 侧)、`listener.log`(监听器侧)、`last-trigger.json`(最近一次触发)、`active.json`(当前生效热键)

## 原理

```
DSH Host 进程 (Node, dsh-bosskey 半区)        监听器进程 (PowerShell, 隐藏)
┌──────────────────────────────────┐          ┌────────────────────────────────┐
│ 回环 HTTP :随机端口 + 随机 token   │◀─GET /config──│ Win32 RegisterHotKey(F9)      │
│ 配置读写 config.json              │◀─POST /trigger─│ WM_HOTKEY → 判断主窗口状态     │
│ /boss 命令(会话内直接唤回)        │          │   前台 → ShowWindow(SW_HIDE)   │
└──────────────────────────────────┘          │   其他 → exe "dsh://open" 唤回  │
                                              └────────────────────────────────┘
```

- **唤回走壳的官方通道**:启动 `DeepSeek Harness.exe "dsh://open"` → 壳内 `second-instance` → `focusPrimaryWindow()`(restore + show + focus),与托盘点击同一条代码路径,输入必然正常。这是实测(2026-11-07)579ms 唤回成功的那条路
- **关键坑**:`DeepSeek Harness.exe` 会退化成纯 Node 的唯一原因是环境变量 `ELECTRON_RUN_AS_NODE=1`(DSH host 的子进程环境里就有)。监听器启动唤回进程前会把它从子进程环境里剔除,否则 exe 把 `dsh://open` 当模块路径直接崩
- **隐藏是外置 `ShowWindow(SW_HIDE)`**:Host 插件拿不到 Electron 的 BrowserWindow,只能走 Win32。实测隐藏后壳账面与真实状态会错位,但 `dsh://open` 唤回不受影响(实测恢复 visible + 前台夺回)。若发现隐藏态有输入异常,把 `hideWhenForeground` 设为 `false` 降级为唤起-only
- 回环 HTTP 只绑 `127.0.0.1`,token 每次启动重新生成,不联网、不读凭据
- 监听器崩溃自动重拉(退避 5s/15s/60s/300s,满 5 次放弃并留日志)

## 限制

- 仅 Windows(用了 Win32 RegisterHotKey + 窗口枚举)
- 桌面端专用;浏览器打开的 Web GUI 没有可切换的窗口
- 热键只在 DSH 运行期间有效,退出即释放
- 隐藏半边若遇到渲染输入异常(理论可能,未复现),降级 `hideWhenForeground: false`

## License

MIT
