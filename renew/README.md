# renew 变更登记

每次更新和修改都需要在此文件注册。

> 多语言文档（随主项目维护）：[English](../docs/i18n/README.en.md) · [日本語](../docs/i18n/README.ja.md) · [Русский](../docs/i18n/README.ru.md)；主 [README.md](../README.md)。

## 登记规范

1. 每次改动先在“登记记录”追加一条：日期 / 版本 / 改动内容 / 涉及文件。
2. 版本级说明写在 `<版本>.txt` 里（当前 [0.1.txt](0.1.txt)：项目介绍 + 能力清单 + 修改登记）。
3. 只追加、不删除；失效内容标注原因并保留历史。
4. 改动涉及新文档或新模块时，把路径写进登记记录，方便追溯。
5. 登记后同步更新根目录 [README.md](../README.md) 的“项目文档”索引（新增文档时）。

## 注册文件

| 文件 | 内容 |
|---|---|
| [0.1.txt](0.1.txt) | v0.1 项目介绍、能力清单、文件修改登记、使用入口与下一步 |

## 登记记录

| 日期 | 版本 | 改动内容 | 涉及文件 |
|---|---|---|---|
| 2026-11-10 | 0.1 | 初始化变更登记（介绍与修改清单） | `renew/README.md`、`renew/0.1.txt` |
| 2026-11-10 | 0.1 | 本地模型队长、1 倍速协作入口、插件事件/敌情字段 | `captain.mjs`、`captain-model.mjs`、`coop.mjs`、`client.mjs`、`server.mjs`、`plugin/WorldData.cs` |
| 2026-11-10 | 0.1 | 三大基础能力设计与调研（状态/交流/异步执行、DSH 中断与流式、查询策略、体量排名） | `架构分析-三大基础能力.md` |
| 2026-11-10 | 0.1 | 地图数据系列分析（数据量/优化/分块读取/分块策略/分层结构/障碍物） | `地图数据量分析.md`、`地图数据优化方案.md`、`地图分块读取方案.md`、`地图分块分配策略.md`、`地图分层结构分析.md`、`地图分块数量与障碍物分析.md` |
| 2026-11-10 | 0.1 | runtime 状态系统骨架（管道客户端/事件引擎/状态服务） | `runtime/pipe-client.mjs`、`runtime/events.mjs`、`runtime/state-service.mjs` |
| 2026-11-10 | 0.1 | 项目文档更新：状态/文档索引/运行时说明/数据量说明/变更登记入口；新增运行时模块文档 | `README.md`、`runtime/README.md`、`renew/README.md`、`renew/0.1.txt` |
| 2026-11-10 | 0.1 | P0 运行时 MVP：状态服务完善 + 本地 HTTP API + 启动入口 + 假桥单测（state 10 项、hub 5 项全部通过）；文档同步 | `runtime/state-service.mjs`、`runtime/events.mjs`、`runtime/hub.mjs`、`runtime/runtime.mjs`、`runtime/test/*`、`runtime/README.md`、`README.md` |
| 2026-11-10 | 0.1 | 独立地图模块支持全图、周边和路线分页；地图故障单独报告；退役本地模型队长，改由外部 AI 经 MCP 操作 | `plugin/MapQuery.cs`、`plugin/WorldData.cs`、`plugin/Plugin.cs`、`map-query.mjs`、`server.mjs`、`client.mjs`、`coop.mjs`、`runtime/state-service.mjs`、`runtime/test/state-service.test.mjs`、`runtime/README.md`、`README.md`、`renew/0.1.txt` |
| 2026-11-10 | 0.1 | Runtime 异步执行、DSH 优先唤醒和流式回传、MCP 工具与集成测试 | `runtime/exec-service.mjs`、`runtime/scheduler.mjs`、`runtime/dsh-client.mjs`、`runtime/runtime-mcp.mjs`、`runtime/runtime.mjs`、`runtime/hub.mjs`、`runtime/state-service.mjs`、`runtime/test/async-runtime.test.mjs`、`coop.mjs`、`config/dsh.patch.yml`、`config/codex.toml`、`package.json`、`package-lock.json`、`runtime/README.md`、`README.md`、`renew/0.1.txt` |
| 2026-11-11 | 0.1 | DSH 自主带队接线，原生 MCP 只读调查、分工校验与首次唤醒、独立后台回执 | `server.mjs`、`config/dsh.patch.yml`、`runtime/exec-service.mjs`、`runtime/hub.mjs`、`runtime/runtime.mjs`、`runtime/runtime-mcp.mjs`、`runtime/scheduler.mjs`、`runtime/test/async-runtime.test.mjs`、`runtime/README.md`、`renew/0.1.txt` |
| 2026-11-11 | 0.1 | 浮窗实时消息、读入回执和订单结果流。后台订单可在恢复焦点后自动提交 | `.local/steam-test/chat-window.ps1`、`coop.mjs`、`runtime/chat-client.mjs`、`runtime/dsh-client.mjs`、`runtime/exec-service.mjs`、`runtime/scheduler.mjs`、`runtime/test/async-runtime.test.mjs`、`runtime/README.md`、`renew/0.1.txt` |
| 2026-11-11 | 0.1 | 将实时浮窗的 Windows 启动入口纳入仓库 | `scripts/Start-RuntimeChat.ps1`、`runtime/README.md`、`renew/0.1.txt` |
| 2026-11-11 | 0.1 | 新增天气/月相查询：读最近存档 `data.json` 的 `WeatherControllerSerialized`，提供 `get_weather` MCP 工具与 `weather.mjs` 命令行 | `weather.mjs`、`server.mjs`、`package.json`、`README.md`、`renew/README.md`、`renew/0.1.txt` |
| 2026-11-11 | 0.1 | 新增实战经验文档（人机同步协作、工具边界、搜刮/战斗/天气坑位、沟通协议、实测数据），供后续模型直接上手 | `经验-无感染区AI协作.md`、`README.md`、`renew/README.md`、`renew/0.1.txt` |
| 2026-11-11 | 0.1 | 新增交接文档与 PS 5.1 兼容的浮窗启动器；修复 DSH 会话 id 需带 `session-` 前缀导致 follow 失败的问题 | `handover/README.md`、`handover/Start-ChatWindow-ps5.ps1`、`runtime/dsh-client.mjs`、`README.md`、`renew/README.md`、`renew/0.1.txt` |
| 2026-11-11 | 0.1 | 经验文档追加"问题分析"章节；新增 10 个复合 MCP 工具（observe/get_threats/get_economy 等），工具总数 22→32 | `经验-无感染区AI协作.md`、`tools-extra.mjs`、`server.mjs`、`README.md`、`renew/README.md`、`renew/0.1.txt`、`.local/test/tool-list-check.mjs`、`.local/test/tool-call-check.mjs` |
| 2026-11-11 | 0.2 | 插件升级 0.2.0：新增 10 个作弊/调试桥接工具（cheat_*，封装游戏自带 GameConsoleCommandHandler）+ `get_terrain_grid` 地形栅格；MCP 工具总数 32→43；已重编并部署到 Steam 版 BepInEx/plugins | `plugin/Cheats.cs`、`plugin/Terrain.cs`、`plugin/Plugin.cs`、`server.mjs`、`README.md`、`renew/README.md`、`renew/0.1.txt` |
| 2026-11-12 | 0.2.2 | 添加许可证：PolyForm Noncommercial 1.0.0（允许下载/修改/非商业再分发，禁止商用）；新增 THIRD_PARTY_NOTICES；README/三语文档/package.json 同步；仓库不含游戏文件 | `LICENSE`、`THIRD_PARTY_NOTICES.md`、`README.md`、`docs/i18n/README.*.md`、`package.json`、`renew/README.md`、`renew/0.1.txt` |
| 2026-11-12 | 0.2.2 | 多国翻译：i18n.mjs（74 工具描述支持 zh-CN/en/ja/ru，`--lang`/`IFZ_MCP_LANG`）+ 英/日/俄三语 README + 英文版架构图 + 中文 README 运行截图 | `i18n.mjs`、`server.mjs`、`docs/i18n/*.md`、`docs/i18n/images/*.png`、`README.md`、`renew/README.md`、`renew/0.1.txt` |
| 2026-11-12 | 0.2.2 | 版本收口 0.2.2：插件 36 桥接方法 / MCP 74 工具；新增地形栅格、建筑资源图标、搜刮进度、远征地块、全图车辆、任务详情与行动计划、11 个作弊工具、文档配图；README 重写为详细版 | `plugin/*.cs`、`server.mjs`、`tools-extra*.mjs`、`README.md`、`docs/img/*.png`、`handover/README.md`、`经验-无感染区AI协作.md`、`renew/README.md`、`renew/0.1.txt` |

| 2026-11-12 | 0.2.2 | 发布精选源码快照；补齐可运行的工具自检命令，更新只读模式测试与公开文档 | `package.json`、`scripts/check-tools.mjs`、`runtime/test/async-runtime.test.mjs`、`README.md`、`docs/i18n/*.md`、`handover/README.md`、`runtime/README.md`、`config/`、`renew/` |
| 2026-11-12 | 0.2.2 | 修复长局历史限制和未知订单占用，加入本地写入认证、地图距离排序、岗位差分和分类等待 | `runtime/`、`plugin/Plugin.cs`、`plugin/UnitControl.cs`、`plugin/BuildingInfo.cs`、`plugin/Expedition.cs`、`config/codex.toml`、`README.md` |
| 2026-11-12 | 0.2.2 | 两个聊天浮窗只显示最近 50 条消息，完整记录写入本地 UTF-8 日志 | `scripts/ChatTranscript.ps1`、`scripts/Start-RuntimeChat.ps1`、`handover/`、`runtime/README.md` |
| 2026-11-12 | 0.2.2 | 无线电正文、选项后果提示、原生选择和后续台词；Runtime 发现可选回复时唤醒模型 | `plugin/RadioDialogue.cs`、`plugin/Plugin.cs`、`plugin/UnitControl.cs`、`plugin/IfzMcp.csproj`、`server.mjs`、`i18n.mjs`、`runtime/`、`README.md`、`docs/i18n/` |
| 2026-11-12 | 0.2.2 | 增加只读小队经验与武器详情工具，输出队员技能修正后的射程和武器基础战斗数值 | `plugin/SquadWeaponData.cs`、`plugin/Plugin.cs`、`server.mjs`、`i18n.mjs`、`runtime/test/async-runtime.test.mjs`、`README.md`、`docs/i18n/` |

## 待办

- 后续每次改动在此追加登记记录；补齐 P0 运行时后视情况新增 `0.2.txt`。
