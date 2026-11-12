# runtime（AI 协作运行时）

目标：让 AI 不再"每条命令等返回、每轮全量读游戏"，由常驻 Node 进程承担三件事：

1. **实时游戏状态系统**：统一缓存 + 版本 + 增量差分 + 语义事件 + 长轮询；
2. **异步游戏执行系统**：模型提交动作立即返回，执行器独立执行并回注结果；
3. **持续交流系统**：常驻调度器唤醒 DSH 会话（用户消息最高优先级、流式回复、任务中断）。

设计与调研见 [架构分析-三大基础能力.md](../架构分析-三大基础能力.md)。

## 模块状态

| 文件 | 状态 | 职责 |
|---|---|---|
| `pipe-client.mjs` | ✅ 已完成 | 直连插件命名管道的帧式客户端；离线码归一化（bridge_offline） |
| `events.mjs` | ✅ 已完成 | 语义事件引擎：敌情逼近/被围、低血、订单完成/变化、满载、低补给、昼夜/新一天、任务变化、卡住、暂停/焦点；带去重窗口与迟滞 |
| `state-service.mjs` | ✅ P0 主体完成 | 单路状态轮询、内容版本、按类目差分、事件游标、长轮询、掉线重连、会话切换重建和独立的地图后台刷新 |
| `hub.mjs` | ✅ 已完成（5 项测试通过） | 本地 HTTP API：`/health`、`/state`（全量/增量）、`/state/wait`、`/events`、`/events/wait` |
| `runtime.mjs` | 已接入 | 装配状态服务和 HTTP API，按启动参数启用执行器和 DSH 调度 |
| `exec-service.mjs` | 假桥闭环通过 | 单写者、请求去重、排队取消、原生回执跟踪和结果事件 |
| `scheduler.mjs` | 假 DSH 闭环通过 | 用户消息优先、事件合并、危险引导、显式中断和重试 |
| `dsh-client.mjs` | 实际 DSH 只读订阅通过 | 通过本机认证 RPC 投递消息，订阅指定会话的助手流 |
| `runtime-mcp.mjs` | MCP stdio 闭环通过 | 缓存与事件读取、动作提交、查回执和取消 |
| `chat-client.mjs` | 假 DSH 闭环通过 | 为本机浮窗并行投递消息和接收实时流 |

## 数据流

```
游戏 + 插件 ──命名管道──▶ pipe-client ──▶ state-service ──▶ events
                                              │
                          ┌───────────────────┼───────────────────┐
                          ▼                   ▼                   ▼
                   本地 HTTP API         exec-service        scheduler
                 （AI/浮窗/CLI）      （异步动作执行）    （DSH 唤醒/流式）
```

## 本地 HTTP 和 MCP 接口

| 接口 | 语义 |
|---|---|
| `GET /health` | 桥接状态、版本、轮询统计、错误和当前分工 `assignment`。仅 `assignment.ready` 为真时可提交新订单 |
| `GET /state?since=<v>&cats=...` | 有 since 返回增量（added/updated/removed），否则全量 |
| `GET /state/wait?since=<v>&timeoutMs=...` | 长轮询：有变化才返回，超时返回 `changed:false` |
| `GET /events?since=<cursor>&types=...` | 语义事件增量 |
| `GET /events/wait?since=<cursor>&timeoutMs=...` | 事件长轮询（调度器主循环） |
| `POST /actions` | 入队后返回 HTTP 202 和任务。请求含 `requestId`、`sessionId`、`squadId`、`command`、`params`、`notice` |
| `GET /actions/<id>` | 读取任务状态、游戏回执和错误 |
| `DELETE /actions/<id>` | 取消排队任务，或请求中止提交前的准备 |
| `POST /actions/<id>/resolve` | 玩家核对游戏后释放待确认的任务。Runtime 会再次检查小队当前订单与队列 |
| `POST /messages` | 将含 `requestId` 和 `text` 的用户消息优先投递给 DSH。设置 `interrupt: true` 时先中断当前回合。DSH 确认接收后返回 |
| `GET /stream` | SSE 推送 DSH 助手片段、消息读入回执、回合边界、连接状态和订单结果 |
| `GET /dialogue` | 从游戏读取当前无线电正文、可选回复和上一次选择后的台词 |
| `POST /dialogue/choose` | 通过游戏原生按钮提交指定的无线电回复 |

同一个动作或用户消息重试时沿用原 `requestId`。每类已结束记录在进程内最多保留 30 分钟或 20,000 条。重启 Runtime 或记录过期后，先核对游戏或 DSH 的实际状态，再决定是否提交。执行器串行提交原生订单，并在提交后继续观察。缺少完成证据时，任务显示为 `unknown`、`held: true`，同时保留小队和搜刮目标的占用，直到查到结果或玩家核对后释放。

写接口和浮窗事件流使用 `x-ifz-token`。启用动作或 DSH 时，Runtime 默认在 `%LOCALAPPDATA%\ifz-runtime\token` 生成令牌，同一账户下的 Runtime MCP 和浮窗会自动读取。可用 `IFZ_RUNTIME_TOKEN_FILE` 指定受当前用户保护的路径，或给各进程设置相同的 `IFZ_RUNTIME_TOKEN`。使用 `--require-token` 可同时保护查询接口。动作与消息接口分别限制为每 10 秒 20 和 10 次。

MCP 工具对应 `runtime_health`、`world_snapshot`、`world_wait`、`events_poll`、`events_wait`、`action_submit`、`action_status` 和 `action_cancel`。地图和单位的直接查询仍可使用现有游戏 MCP。

## 启动

默认只读。Steam 模式加入 `--steam`，端口默认为 8790。加 `--buildings` 时缓存总部 200 世界单位内的搜刮候选。

```powershell
node runtime/runtime.mjs --steam --port 8790
curl http://127.0.0.1:8790/health
```

启用动作需要当前游戏会话 UUID、玩家保留队和 AI 可操作队。会话变化后重新确认分工。

```powershell
$gameSession = '替换为当前游戏会话 UUID'
node runtime/runtime.mjs --steam --enable-actions --game-session $gameSession --player-squad '834' --squads '835,836'
```

开启 DSH 自动唤醒需要同一个游戏会话 UUID、明确的 DSH 会话 UUID，以及 `--dsh-home` 或 `DSH_HOME`。在 DSH 会话里选择外部大模型。危险和普通事件会合并后投递，用户消息优先。运行时可在只读模式下启用唤醒。

```powershell
$dshSession = '替换为已在 DSH 打开的会话 UUID'
node runtime/runtime.mjs --steam --game-session $gameSession --dsh-session $dshSession --dsh-home $env:DSH_HOME
```

同时启用执行和唤醒时，把两组参数放在同一条启动命令里。用 [DSH 配置示例](../config/dsh.patch.yml) 或 [Codex 配置示例](../config/codex.toml) 注册 `ifz_runtime`。两份示例均以 `--read-only` 注册原生 MCP，协作下单由 Runtime 执行。若 runtime 使用其他端口，在该 MCP 进程的环境中设置 `IFZ_RUNTIME_PORT`。

## DSH 自主带队

1. 进入聚落后确认游戏会话、玩家保留队、AI 小队和要绑定的 DSH 会话，再同时启用执行和唤醒。分工首次有效时，调度器会通知 DSH 调查局势并开始带队。
2. 运行时在后台采集状态。小队、车辆和敌情的轮询间隔默认为 500 毫秒，另计桥接读取耗时。DSH 用 `world_snapshot` 按类目读缓存，查具体建筑和路线时用原生只读 MCP。
3. DSH 用 `action_submit` 下单，拿到任务 ID 后结束本轮。执行器独立提交原生订单并跟踪结果，调度器在行动结束或重要局势变化时唤醒 DSH。玩家消息可直接在 DSH 发送，或通过 `/messages` 优先引导下一步。打断 DSH 回合时，已入队的后台任务仍由执行器处理。`action_cancel` 可取消尚未提交给游戏的任务。
4. 换档、缺少已分配的小队或桥接离线时，`assignment.ready` 会变为 `false`。恢复协作前先核对分工和仍在执行的游戏订单。

### 无线电剧情选择

安装本版编译的插件并进入聚落。Runtime 的 `--enable-actions` 同时允许无线电选择。只授权无线电时使用 `--enable-dialogue-choices`，可省略小队分工。绑定 DSH 会话后，`dialogue_options_available` 会在选项可点时唤醒模型。

1. 调用 `get_active_dialogue`。返回当前已显示的 `dialogue.text`、选项全文、可选状态、是否结束通话以及游戏提示的 `effect_hints`。提示会列出已知资源、士气或人口变化等，空数组表示游戏没预告后果。
2. 用返回的 `session_id`、`choice_id` 和 `option_id` 调用 `choose_dialogue_option`，并生成一个 `request_id`。请求超时可用原 ID 重试。玩家先选或对话已换到下一步时，原选项会失效。
3. 再次调用 `get_active_dialogue`。即使无线电面板已经关闭，也能在 `last_choice.observed_lines` 读取这次选择之后实际播放的台词。资源等实际变化可用现有状态工具核对。

原生 MCP 的 `get_active_dialogue` 要求传入当前 `session_id`。原生写模式可用同名写工具，调用时传入写租约。无线电选择沿用游戏自身的暂停和恢复规则。普通系统确认框由玩家处理。

### 游戏浮窗实时模式

绑定 DSH 会话并启用运行时后，在 Windows 上用 PowerShell 7 启动仓库自带的浮窗脚本，连接同一个端口。

```powershell
pwsh -STA -File .\scripts\Start-RuntimeChat.ps1 -Port 8790
```

- 回车把消息优先送到 DSH 的下一步。若 DSH 还在前台命令中，`Ctrl+回车` 可打断当前回合。后端执行器负责已经入队的游戏动作。
- 浮窗分别显示 DSH 已收件、消息已读入对话，并持续追加回复文本和订单结果。投递未确认时，用同一原文和快捷键重试会沿用请求 ID。
- 浮窗保留最近 50 条消息。一条流式回复按一条消息计数。每次打开浮窗都会在 `.local/logs/chat/` 新建 UTF-8 日志，完整保留本次消息。流式回复在结束、断线或关闭浮窗时写入。
- 下单保留 HUD 预告，预告写入后立刻做安全检查并提交。游戏暂停或因浮窗失焦时，后台保留待发订单。游戏恢复可操作后自动提交，超过 30 秒的待发订单会过期。

## 事件类型（events.mjs）

`enemy_approach`（info/warn/critical）、`squad_low_hp`、`squad_threat`、`order_completed`、
`order_changed`、`cargo_full`、`low_stock`、`nightfall`、`new_day`、`mission_updated`、
`squad_stuck`、`game_paused_changed`、`focus_changed`、`session_changed`、
`bridge_offline`、`bridge_restored`、`bridge_error`、`action_finished`。

## 开发与验证

- 测试：
  ```
  node --test runtime/test/*.test.mjs
  ```
  覆盖：时钟漂移不算变化、差分只返回变化字段、敌情分级/去重、低血/订单完成事件、
  长轮询、会话切换、地图故障隔离、异步提交和原生回执、重复请求、DSH 重试及 SSE 转发。
- 实机验收待做。用隔离存档验证游戏事件唤醒 DSH、DSH 提交动作和游戏回执返回。

## 关键实测数据（2026-11-10，第 6 天存档）

- 单次 MCP 调用 16–20 ms（≈60fps 一帧）；一轮 observe（7 类）115 ms；
- 旧版全量 buildings 6749 条 / 68 页 / 1.34–1.83 s。新版由 AI 通过 `get_map_buildings` 选择范围和分页；
- groups 15 条但每群最多 32 人明细，约几十 KB；
- MCP 层支持并发：7 个调用并发 30.8 ms vs 串行 184.9 ms；
- DSH `/api/remote.mux` + `session/follow` 已验证可拿到 snapshot/事件/流式 token。
