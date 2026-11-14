# NPC 聚落与大远征查询

2026-11-14 第二批扩展，新增 6 个原生只读工具。默认 MCP 工具数从 126 增至 132；纯只读模式 99 个，平民协作含建造模式 105 个。全部新查询要求当前 `session_id`，不需要写租约。

## 查询入口

| 工具 | 用途 | 可选参数 |
|---|---|---|
| `get_npc_zone` | 当前地图的 NPC 聚落类型、发现/接管状态和摘要 | `include_hidden` |
| `get_npc_zone_groups` | 只列属于该聚落的人员群组，区分普通路过移民 | `include_hidden`、`offset`、`limit` |
| `get_npc_zone_structures` | 该聚落所属建筑和其他设施的状态、位置、归属 | `include_hidden`、`offset`、`limit` |
| `get_group_relations` | 实体群组对玩家的真实关系，独立列出可见性与可攻击性 | `group_id`、`include_hidden`、`offset`、`limit` |
| `get_convoy_locations` | 当前已记录的大远征目的地区域、地名和访问情况 | `location_type`、`include_unrevealed`、`offset`、`limit` |
| `get_convoy_status` | 当前车队上下文、实况摘要和已访问地区分页 | `offset`、`limit` |

列表分页 `limit` 范围为 1–100，按照返回的 `next_offset` 继续读取。`include_hidden` 默认 false；设为 true 只读取游戏已经加载的隐藏实体，不调用揭示、生成或接管逻辑。

NPC 人员按当前 `IsVisible()` 过滤；建筑没有统一的实时可见字段，因此按整区 `NpcZoneRevealed` 控制未发现信息。返回的 `visibility_scope` 说明这个区别，不代表所有已发现建筑目前都在视野内。

目的地默认使用已经登记的区域记录。`include_unrevealed=true` 才会纳入已缓存但未登记的地点，不触发新搜索。`get_convoy_status` 的 `IsConvoyStart` 对应特殊车队开局 ID，不能解释为正在出发；当前实况货物也不能当作历史出发时携带的货物。

新工具源码为 `plugin/NpcZones.cs`、`plugin/ConvoyIntel.cs`，经 `plugin/Plugin.cs` 的 `RequireSession` 校验后在游戏主线程执行。`server.mjs` 注册 schema 和只读注解。

## 区域与人员的区别

大远征区域类型来自 `Convoy.Locations.LocationType`：

| 类型 | 含义/已核实关系 |
|---|---|
| `NeutralZone` | 中立聚落，人员内部映射为 `Immigrants` |
| `FarmersZone` | 农民聚落，人员同样映射为 `Immigrants` |
| `RaidersCamp` | 掠夺者营地，映射为 `Bandits` |
| `PurifiersZone` | 净化者聚落，映射为 `Provirus` |
| `AbandonedZone` | 废弃区域 |
| `MilitaryZone` | 军事区域；不能仅凭名称推断当前人员关系 |
| `NuclearZone` | 核区域 |
| `NormalPlace` / `QuietPlace` | 普通/安静地点 |

`NpcZoneGroup` 标签标识聚落人员。因此，仅筛选 `faction=Immigrants` 不能区分聚落居民和路过移民。当前地图由 `NpcZoneController` 管理 NPC 聚落，而大地图可以缓存多个不同类型的目的地。

`current_npc_group_count` 和人员清单统计现存且带标签的非玩家群组。接管后仍可能保留这些群组；接管获得的平民由其他机制计入总部，不能将这里的群组人数当作接管奖励或居民总数。

`get_expedition_tiles.location_type` 与大远征使用同一个区域枚举，可以显示部分类型，但近郊搜刮瓦片不等于完整的大远征目的地目录。`get_convoy_locations` 使用地理瓦片的 `tx/ty/zoom`，不能将其直接传给使用本地世界 `x/z` 的移动指令。

首次发现中立/农民聚落后，非敌对群组可以进入 `WaitingForTransmission`，由原生事件和通讯推进交互。现有 `get_active_dialogue` 和 `choose_dialogue_option` 用于读取、选择真实可用的无线电回复；本批工具不直接调用接管建筑、强制敌对或迁移函数。具体交易、招募条件取决于当前事件，不根据区域名称猜测。

## 真实关系与旧报告修复

真实关系来自 `AffiliationProvider`，可能为 `Own`、`Hostile`、`Neutral`、`Indifferent`，未知时保留 null。它与“当前是否看得见”“能否作为攻击对象”是不同信息。旧桥接的 `hostile_to_player` 组合了可见、可攻击和小队敌意检查，false 不足以证明中立。

`get_world_data(groups/squads)` 增加以下字段，原字段保留：

- `affiliation_to_player`：原生对玩家关系。
- `npc_zone_member`：是否拥有聚落人员标签。
- `immigrants_state`：原生移民/通讯阶段。
- `can_be_attacked`：原生可被攻击条件，不代表已获准向中立人员开火。

`get_neutral_report` 修复了进入非敌对人员分支时 `variants` / `maxTier` 未定义的错误，改为优先使用真实关系，并排除玩家自己的队伍。中立 Bandits 不再因为阵营名被漏掉，敌对 Provirus/Army 等也不再因阵营名不同而被当成中立。旧插件字段不足时明确标记兼容推断，隐藏且关系未知的群组不算作中立。

报告保留原有 `groups` 等返回字段，增加输出上限和未知/排除情况说明。`attackable` 使用真实可攻击字段或未知状态，取消原先“一律不可攻击”的假定。

旧态势摘要 `summarizeThreats`、敌情工具和 `get_mission_plan` 共用 `group-relations.mjs` 的关系解析，避免同一个中立聚落在不同工具里被分类为敌人。敌对候选保留关系来源、可见性和原生攻击条件；任务规划的感染者目标仍限定为感染者。关系未知时不推断为敌人，真实敌意也不表示目前可以开火。

## 使用顺序

```powershell
# 先读取状态，并把返回的真实 session_id 填入后续 JSON。
node client.mjs --steam get_state '{}'
node client.mjs --steam get_tool_catalog '{"query":"npc"}'

# 示例参数中的 UUID 必须替换为本次聚落会话 ID。
node client.mjs --steam get_npc_zone '{"session_id":"<当前会话UUID>"}'
node client.mjs --steam get_npc_zone_groups '{"session_id":"<当前会话UUID>","limit":30}'
node client.mjs --steam get_convoy_locations '{"session_id":"<当前会话UUID>","location_type":"FarmersZone","limit":30}'
node client.mjs --steam get_neutral_report '{"include_animals":false,"include_hidden":false,"limit":30}'
```

如查询结果表示尚未初始化、未发现或没有已缓存目的地，应保留该状态，不通过查询擅自生成区域。NPC 设施仍不列入玩家的 `get_facilities`；它们由独立的 NPC 结构查询读取。

## 实现依据与验证边界

本批沿用已经核对的 BepInEx/原生主线程查询路线，没有新依赖。机制依据本项目对应游戏构建的 `NpcZoneController`、`NpcZoneSpawner`、`ConvoyLocations`、`ConvoyData` 和群组关系 API。

开发者曾说明新地图的当地聚落可以交易，但被摧毁或接管后条件会变化：[开发者答复](https://steamcommunity.com/app/1465460/discussions/0/597412189643814114/)。本实现只暴露实际状态，不从通用交易控制器推断完整外交功能。

验证结果：`npm test` 全部 **110 项通过**，包括三种 MCP 模式的实际注册/schema 检查、中立报告 14 项行为测试和关系/任务规划 9 项行为测试。工具目录可离线检索到新增接口。插件编译 **0 错误、3 项既有警告**（System.Net.Http 引用冲突及 2 项过时 API）；产物为 `plugin/bin/Release/netstandard2.1/IfzMcp.dll`，未复制到游戏目录。

本次检查时桥接离线，原生工具需更新 `IfzMcp.dll` 并进入聚落后进行实机验证。Node 注册或单元测试通过不能证明当前存档下的原生行为已经验证。不要把旧插件返回的 `unknown_method` 当作“没有 NPC 聚落”。
