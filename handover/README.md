# 交接：游戏内聊天浮窗 + 多智能体监视（IFZ 人机协作）

> 目的：新会话/新模型接手时，按本文件即可把「游戏内聊天浮窗」和「多智能体监视」恢复起来。
> 来源：2026-11-11 实战会话（第 14→25 天），所有命令与坑位均在真机验证过。
> 相关文档：[AI游戏协作规则.md](../AI游戏协作规则.md)、[经验-无感染区AI协作.md](../经验-无感染区AI协作.md)、[renew 登记](../renew/README.md)
> 多语言文档：[English](../docs/i18n/README.en.md) · [日本語](../docs/i18n/README.ja.md) · [Русский](../docs/i18n/README.ru.md)（主 README 见 [README.md](../README.md)）

---

## 0. 一句话流程

```
1) 确认游戏已进入聚落（MCP status: ready=true）
2) 启动 runtime（绑定本 DSH 会话 + 游戏会话）
3) 本机没有 PowerShell 7 → 用 handover/Start-ChatWindow-ps5.ps1 开浮窗
4) 校验：/health 的 dsh.connected=true，浮窗出现
```

---

## 1. 需要先拿到的 4 个值

| 值 | 怎么拿 |
|---|---|
| 游戏会话 UUID | MCP `get_state` 的 `session_id` |
| DSH 会话 UUID | `$env:DSH_SESSION_ID` 或 DSH 中当前会话的 ID |
| DSH_HOME | `$env:DSH_HOME` 或 DSH 配置目录 |
| DSH Web 地址 | 默认 `http://127.0.0.1:3080` |

```powershell
$env:DSH_SESSION_ID; $env:DSH_HOME; $env:DSH_WEB_URL
```

---

## 2. 启动 runtime（必须先起，浮窗只是它的客户端）

```powershell
$gameSession = '替换为当前游戏会话 UUID'
node runtime/runtime.mjs --steam --port 8790 `
  --dsh-session $env:DSH_SESSION_ID `
  --game-session $gameSession `
  --dsh-home $env:DSH_HOME
```

- 用**后台 job**运行（会话结束会回收它，需要时重开即可）
- **不要**加 `--enable-actions`：游戏写入由 Lead 的原生 MCP 负责，双写会冲突
- 校验：

```powershell
Invoke-RestMethod http://127.0.0.1:8790/health |
  Select-Object ready, online, @{n='dsh';e={$_.dsh.connected}}, @{n='err';e={$_.dsh.lastFollowError}}
```

期望：`ready=True`、`online=True`、`dsh=True`、`err` 为空。

### ⚠️ 关键坑：DSH 会话 id 必须带 `session-` 前缀

DSH 的 `session/follow` 接口要求地址形如 `session-<uuid>`，传裸 UUID 会返回 `session/not-found`，表现为 `dsh.connected=false`、浮窗消息 `dsh_delivery_unconfirmed`。
仓库已修复：`runtime/dsh-client.mjs` 构造时自动补前缀（2026-11-11 变更）。如果换成旧代码，请确认这段归一化还在。

---

## 3. 启动游戏内聊天浮窗

PowerShell 7 可运行 `scripts/Start-RuntimeChat.ps1`。使用 Windows PowerShell 5.1 时，从仓库根目录启动兼容版。

```powershell
powershell.exe -STA -NoProfile -File .\handover\Start-ChatWindow-ps5.ps1 -Port 8790
```

校验（应看到标题为 `DSH 游戏聊天` 的置顶窗口）：

```powershell
Get-Process powershell | Where-Object MainWindowTitle | Select-Object Id, MainWindowTitle
```

浮窗用法：
- **回车** = 优先插话（Agent 在下一步读到，会打断它的等待）
- **Ctrl+回车** = 硬打断当前回合（等价 DSH 的 steer/中断）
- 状态栏会显示：正在连接 / DSH 实时连接 / 已收件 / 已读入对话 / 投递未确认
- 浮窗显示最近 50 条消息。完整记录保存在仓库的 `.local/logs/chat/`，每次打开浮窗新建一个日志文件。

### 兼容版做了什么（改了 4 处）

1. `#requires -Version 7.0` → `5.1`
2. `ProcessStartInfo.ArgumentList.Add(...)` → `$info.Arguments = '"{0}" {1}' -f $chatClient,$Port`
3. 删除 `StandardInputEncoding`（.NET Framework 没有），保留 `StandardOutputEncoding=UTF8`
4. 发往 node 的 JSON 做 `[^\x00-\x7F]` → `\uXXXX` 转义，规避 5.1 stdin 中文乱码
5. 脚本文件必须存成 **UTF-8 with BOM**，否则 5.1 按 ANSI 解析报"意外的标记"

---

## 4. 多智能体监视（只读）

监视客户端可读取 Runtime 的 `/state` 和 `/events`，汇报敌情、资源短缺和行动结果。接口见 [Runtime 文档](../runtime/README.md)。

---

## 5. 重启后的恢复清单（30 秒）

```powershell
# 1) 游戏侧
(Invoke-RestMethod http://127.0.0.1:8790/health) | Select ready,online,@{n='dsh';e={$_.dsh.connected}}
# 2) 浮窗
Get-Process powershell | Where-Object MainWindowTitle | Select Id,MainWindowTitle
```

按第 2、3 节恢复 Runtime 和浮窗。runtime 重启后浮窗会自动重连（读它的状态栏）。

---

## 6. 故障排查速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 浮窗消息「投递未确认（dsh_delivery_unconfirmed）」 | runtime 的 `dsh.connected=false`（多为 session id 没前缀） | 查 `/health` 的 `lastFollowError`；确认 `dsh-client.mjs` 会补 `session-` 前缀；重启 runtime |
| `#requires -Version 7.0` 报错 / `pwsh` 未找到 | 本机只有 PS 5.1 | 用 `handover/Start-ChatWindow-ps5.ps1` |
| 脚本报"意外的标记 'Top'"等解析错误 | 文件不是 UTF-8 BOM，中文被按 ANSI 读 | 用 `[IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding($true)))` 重存 |
| `Cannot find module ...chat-client.mjs` | 脚本在子目录里，`Split-Path -Parent $PSScriptRoot` 少算一层 | 本目录脚本已按"上一级=仓库根"处理；复制到别处要同步改 |
| 浮窗能打字但显示连接中断 | node 客户端进程退出 | 关浮窗重开；确认 runtime 在 8790 |
| 中文消息变 `??????` | PS 5.1 写 stdin 用了 GBK | 兼容版已做 `\uXXXX` 转义；不要手动用 `Invoke-RestMethod` 发中文测试 |

---

## 7. 边界与纪律（务必遵守）

- **写游戏**：只有 Lead 用原生 MCP 执行（`acquire_control → pause → 下单 → advance keep_running`）；runtime 保持只读、智能体保持只读
- **监视智能体**：只写 `.local/agents/`，只追加不删除；平时不打扰，只报 critical
- **玩家保留队**：AI 一律不接管
- **浮窗汇报**：简短（1–3 行，带数字），长文留在 DSH 会话里
- **满月**：`node weather.mjs` 可查 `IsFullMoon` 与未来满月；满月夜优先守家

---

## 8. 本目录文件

| 文件 | 用途 |
|---|---|
| `handover/README.md` | 本交接文档 |
| `handover/Start-ChatWindow-ps5.ps1` | PS 5.1 兼容的游戏内聊天浮窗启动器 |
| `runtime/dsh-client.mjs` | DSH RPC/流式客户端（含 `session-` 前缀归一化修复） |

---

## 9. 作弊/调试工具的使用政策（2026-11-11 起）

插件 0.2.2 提供了 11 个 `cheat_*` 桥接工具（见 `plugin/Cheats.cs`）。它们是**紧急与验证工具**，不是日常流程：

1. **仅限紧急情况**，例如：
   - 关键小队即将全灭、无法救援
   - 存档卡死/任务无法完成（`cheat_complete_missions`）
   - 地形或建筑状态导致寻路完全不可用（用 `cheat_reveal_groups`/`cheat_unlock_expedition` 诊断）
   - 玩家明确要求"用作弊把这段跳过"
2. **判断权在 AI**：AI 可自行判断是否属于紧急，但必须先尝试非作弊手段（正常移动/战斗/撤退/生产）。
3. **执行顺序**：先只读诊断（`observe`/`get_threats`/`get_state`）→ 再调用最小干扰的 cheat → **立刻复查数据**（资源/血量/任务/小队）确认结果，并写进 `.local/runs/` 的会话档案。
4. **禁止**在没有诊断数据时批量使用重型命令（任务完成、时间跳跃、刷资源）。
5. 破坏性/不可逆（`cheat_complete_missions`、`cheat_spawn_squad` 刷队、`cheat_set_time` 跳天）调用前，若玩家在线应一句话告知。
