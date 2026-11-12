# 经验：《无感染区》AI 人机同步协作实战

> 来源：2026-11-11 的连续实战会话（第 14 天 → 第 21 天，真实存档，玩家 1 倍速同玩）。
> 目的：给后续接手本项目的模型一份**可直接照做**的操作手册，避免重复踩坑。
> 配套文档：[AI游戏协作规则.md](AI游戏协作规则.md)（分工与红线）、[README.md](README.md)（工具清单）、[路线分析.md](路线分析.md)（原生入口）。
> 多语言文档：[English](docs/i18n/README.en.md) · [日本語](docs/i18n/README.ja.md) · [Русский](docs/i18n/README.ru.md)（主 README：[README.md](README.md)，含运行截图与架构图）

---

## 0. 一句话结论

**能读能写，但每个写操作都要"先 pause、带 lease、带 request_id、下完立刻还 1 倍速"；搜刮失败多半是墙或目标失效；敌人必须先进入视野（visible）才能被 attack_group 点名；天气/月相不在 MCP 里，只能读存档。**

---

## 1. 能力边界（先认清什么做不到）

| 想做的事 | 现状 | 替代方案 |
|---|---|---|
| 派小队上远征（`MoveToExpeditionTileOrder`） | ❌ 无工具，只有游戏世界地图 UI 能发出 | 让玩家在游戏里点出去，之后可接管该队在远征图的搜刮/移动 |
| 直接用小队的**车辆后备箱**物资回仓 | ⚠️ 部分可行：`return_to_stockroom` 会让小队**先走到车、上车、再开回总部**并自动卸货；但如果小队已经离车很远、或指令时它没上车，就会步行回仓，**车和车内货物留在原地**。返回里的 `mounted` 字段只表示**下单瞬间**是否在车上，不代表最终不坐车 | 看 `vehicles` 里 `owner_group_id` 与位置判断车是否跟队；必要时先 `move_squad` 让它靠近车再回仓 |
| 直接使用医疗包回血 | ❌ 无接口 | A 方案：伤员回总部，靠游戏医疗消耗 `res_drugs`（药品）自动回血；HP<60 整队撤退 |
| 读天气/月相 | ❌ 桥接无 weather 类目 | ✅ 读存档 `data.json → WeatherControllerSerialized`，用 `node weather.mjs` 或 MCP 本地工具 `get_weather` |
| 读建筑血量/墙耐久 | ❌ 未暴露 | 只能从 `completed` 变化、建筑消失间接推断 |
| 全图敌对分布 | ✅ `get_world_data(groups)` 返回全部实体群（**含隐藏群**） | 但一次返回量大（~50 KB），要按页读、按需读 |

---

## 2. 同步协作的节奏（最重要）

1. **玩家玩 1 倍速，AI 只做"短暂停 + 下单 + 立刻还速"**。
2. 写操作的标准流程：
   ```
   acquire_control(owner, ttl≈180)  → 拿到 lease（实际有效期 90s，需要续租）
   pause(lease, session_id)         → 必须由 AI 自己调 pause，状态里显示 paused 也不能代替
   写操作(lease, session_id, request_id=UUID)  → 移动/攻击/搜刮/回仓/补给/库存
   advance(lease, session_id, seconds≈8, keep_running=true, allow_background=true) → 还 1 倍速
   ```
3. **`request_id` 一旦超时/结果不明，只能用同一个 request_id 重试**，换新的会产生重复订单。
4. **`lease_required` = 租约过期**（90 秒），重新 `acquire_control` 即可。
5. **`pause_required` = 你还没真正调 pause**，即使 `get_state` 显示 `paused:true`。
6. **`speed_locked`**：玩家锁了速度，`advance` 不会强行解速——不要反复重试，等玩家放开。
7. **游戏失焦会降频**：窗口不在前台时游戏时间几乎不走（观察过 2 分钟只推进 0.1 小时），此时"没进展"不是卡死。让玩家切回窗口即可。
8. **AI 的等待方式**：不要睡长觉。用户消息只能在两次工具调用之间插入；`Start-Sleep` 超过 ~60 秒会被后台化。实战建议 **30–60 秒一次短检查**，战斗期 30 秒。

---

## 3. 小队管理（AI 队 vs 玩家队）

- 默认分工：玩家保留 1 队（本例 `834`，名字就是"我(用户)"），AI 接管其余（`835/836/1726`）。玩家新建的队（如 `9518`「我(用户)2」）默认仍归玩家，不要动。
- 每队 4 人；`squads` 类目能读位置、载具、`active_order`、背包、每名成员的 `hp/weapon_id/ammo`。
- **车辆会跟着小队走**：给小队下远距离移动/搜刮指令时，小队会先上车再开过去，车停在目标附近。
- 弹药：`refill_squad_member_ammo(source=stockpile)` 可单个队员补满（例：0.89 → 1.0）；需要小队在总部/仓库范围附近才稳妥。
- 换枪：`equip_squad_member(source=cargo|stockpile)`，默认只换"非默认武器"。
- **撤退红线**：任何队员 HP<60 → 整队立刻撤退回总部（规则文件里写死的）。

---

## 4. 搜刮（最容易踩坑的地方）

`scavenge_building` 报 `scavenge_unavailable` 时，插件里就 4 个原因（见 `plugin/UnitControl.cs:198-207`）：

1. `squad.IsOnExpedition()` —— 小队在远征图
2. `!building.CanScavenge()` —— 该建筑不可搜刮
3. `building.IsScavenged()` —— 已经搜过
4. `!squad.CanGoToStructure(building)` —— **小队走不到那栋楼**

实战结论：

- **墙建起来之后，(4) 是最高频原因**。楼在墙内、小队在墙外（或反过来）就会一直失败。玩家需要给围墙留门/缺口。
- `get_map_buildings(scavenge_only:true)` 给的候选**不代表现在仍然可搜**：列表是快照，玩家/其他队可能已经搜掉。失败就换目标，别怀疑工具。
- 每队每次搜刮的产出通常就 **1–3 件**（罐头/燃油/弹药/工具/药品，偶尔整把枪）。别指望一趟暴富。
- **载具后备箱是关键**：combi 15 格、sedan 10 格、minicar 4 格、pickup 20 格。装载 >90% 就该回仓（规则要求）。
- 搜刮终点：`cargo`（身上）+ 车辆 trunk（车里）。回仓时车上物资才会入共享库存。

---

## 5. 敌情与战斗

### 5.1 怎么查
- `get_world_data(category:"groups")`：返回**实体群**，含隐藏群，字段有 `type/faction/position/destination/member_count/visible/hostile_to_player` 和最多 32 名成员明细。
- **小心分页顺序会变**：新群（移民/尸潮）会插进列表，`offset` 会漂移。找特定群时用全量读或按 ID 匹配，不要死记偏移。
- 判断"有没有威胁"：看 `destination` 是否指向总部/聚落，以及位置是否在向聚落靠近。静止窝点的 `destination == position`。
- 远征图的虚拟群组在 `virtual_groups` 另查。

### 5.2 攻击
- `attack_group` 的前置条件（`UnitControl.cs:180-196`）：**目标必须 `IsVisible()`、`CanBeAttacked()`、且是敌对阵营**。
- 所以对 `visible:false` 的隐藏群下单会报 `group_unavailable`/`invalid_attack_target`。**等它进入视野（靠近我们）再打**。
- 实战套路：把 2–3 队用 `move_squad`（6–100 单位/次）压到敌军来路上 → 接火后立刻 `attack_group` 逐群点名 → 群被消灭后对象会返回 `group_unavailable`（这是"打完了"的信号，不是失败）。
- **满月夜/尸潮**：一批会分成多个 5–7 只的小群，从地图边缘向聚落走。典型强度：数十只。4 人满编队 + 霰弹枪/步枪在车边接战，实测可零伤亡全歼 33 只。

### 5.3 撤退与救援
- 有人掉血 → 回总部（药品自动治疗）。
- 家被围攻时优先回防，报"方向 + 距离 + 数量"。

---

## 6. 天气与月相（不在 MCP 里）

数据在存档 `data.json` 的 `WeatherControllerSerialized`：

```
CurrentWeather: Clouds / Precipitation / Temperature / WindDirection / WindStrength / IsFullMoon
WeatherForecast: 38 天，每天同样字段（含 IsFullMoon）
```

- 存档位置：`%USERPROFILE%\AppData\LocalLow\JutsuGames\Infection Free Zone\Saves\<最新存档>\CompressedData.zip` → 里面 `data.json`。
- 封装：`weather.mjs`（`node weather.mjs [--json] [--all-forecast]`）与 MCP 本地工具 `get_weather`（`weather.mjs` 不经过命名管道，桥接离线也能用）。
- **满月周期实测 6 天**（本例：第 18 天满月，之后第 24/25 天左右再来）。
- 满月夜尸潮明显更大；存档里还有 `SuperMoons: true` 难度开关。
- 局限：数据来自**最近一次自动存档**，最多滞后约一个游戏日。

---

## 7. 和玩家协同的沟通协议

- 玩家保留队之外的交给我；玩家说"我暂时接管所有小队"时**立刻停止一切写入**（不要申请租约），转只读监视，等"AI 接管回来"再恢复。
- 报告要短、要可行动：**方向 + 距离 + 数量 + 我正在做什么**。平时沉默，变化才说话。
- 玩家可以随时打断 AI：输入框回车＝排队插入；Ctrl+回车＝硬打断当前回合。AI 侧把等待切成 30–60 秒一段，避免"喊不醒"。
- 玩家下达的临时规则要覆盖默认规则（例："先发展，不打仗"、"有威胁直接攻击"、"只在基地附近发展"）。

---

## 8. 常见误判清单

1. "游戏时间不走" → 多半是失焦降频，不是卡死。
2. "搜刮总失败" → 先想墙/路径，再想目标已搜过；别怀疑工具。
3. "回仓后车还在外面" → 小队下车后回仓是步行的，车与车内货物留在原地。
4. "攻击返回 group_unavailable" → 该群可能已被消灭（正常），不是接口坏了。
5. "小队突然出现在地图边界外" → 它在远征（`active_order: MoveToExpeditionTileOrder`）。
6. "移民群"是非敌对、会走向总部加入，不要打。
7. `get_world_data` 的 `groups` 很大，别每轮全量读；用分页/尾页探测新增。

---

## 9. 本次实战数据（可作为难度/节奏参考）

| 项目 | 数值 |
|---|---|
| 会话跨度 | 第 14 天 → 第 21 天（约 5 小时真实时间） |
| 玩家队 | 834（后期加建 9518） |
| AI 队 | 835 / 836 / 1726 |
| 单次调用延迟 | 16–20 ms；一轮 7 类读取 ~115 ms |
| 满月尸潮 | 6 群 / ~33 只，全歼，12 人零掉血 |
| 金属储备 | 2 → 168（多轮搜刮 + 玩家建造消耗） |
| 常见弹药消耗 | 一场遭遇战每人掉 0–0.1（弹匣比例） |
| 建房/围墙 | 玩家操作；AI 只负责供料与外围搜刮 |

---

## 10. 给其他模型的快速上手清单

1. 先读 [AI游戏协作规则.md](AI游戏协作规则.md)，确认红线与分工。
2. `status` → `get_state` 拿 `session_id` 与玩家保留队。
3. 需要写之前：`acquire_control` → `pause` → 写 → `advance(keep_running:true)`。
4. 搜刮前先用 `get_map_buildings(scope:"nearby", scavenge_only:true)` 取**新鲜**候选；失败就换目标。
5. 敌情用 `get_world_data(groups)` 看 `visible` 与 `destination`；可见才 `attack_group`。
6. 天气/月相用 `node weather.mjs`（或 `get_weather`）。
7. 每次等待 ≤60 秒，战斗期 ≤30 秒；用户随时可以插话打断。
8. 改代码/文档后**必须在 [renew/README.md](renew/README.md) 登记**（项目硬性规则）。

================================================================
追加章节：本次会话遇到的问题分析（2026-11-11）
================================================================

一、工具/环境类（已解决）
1. 浮窗消息投递失败 dsh_delivery_unconfirmed：DSH 的 session/follow 要求
   会话地址形如 session-<uuid>，runtime 传裸 UUID 时返回 session/not-found，
   导致 dsh.connected=false、投递未确认。修复：runtime/dsh-client.mjs 构造时
   自动补 "session-" 前缀。
2. 浮窗脚本无法运行：仓库 scripts/Start-RuntimeChat.ps1 是 PowerShell 7 语法
   （#requires 7.0、ProcessStartInfo.ArgumentList、StandardInputEncoding），
   本机只有 5.1。修复：handover/Start-ChatWindow-ps5.ps1（改 4 处 + UTF-8 BOM）。
3. 中文脚本解析报错"意外的标记"：5.1 在无 BOM 时按 ANSI 读取，中文被拆坏。
   修复：脚本必须存成 UTF-8 with BOM。
4. 中文消息变成 ??????：5.1 向 node 管道写 stdin 用本地代码页。修复：发送前把
   非 ASCII 字符转成 \uXXXX，使 JSON 全 ASCII。

二、游戏操作类
5. 搜刮频繁 scavenge_unavailable：插件判定四条件（远征中/不可搜/已搜过/
   CanGoToStructure 失败）；反编译 Group.cs 确认 CanGoToStructure 与寻路无关，
   核心是 Draft.IsInteractable、Creating、Deconstructing、hideout 进入权限。
   MCP 的候选列表（MapQuery.cs）只过滤 CanScavenge && !IsScavenged &&
   !IsStockroom，未过滤 IsInteractable，因此候选里混有不可交互建筑，只能试错换目标。
   改进：MapQuery 增加 IsInteractable / StateType != Creating / !IsDeconstructing。
6. 一度误判为"围墙封死"：报错未暴露具体条件，先猜成寻路问题。教训：先读插件源码
   再归因。
7. pause_required 频发：玩家操作会持续解除暂停，pause 与下单之间的间隙被解掉。
   改进：写操作紧凑执行；根治靠 runtime exec-service 统一执行。
8. speed_locked / advance 不推进：玩家锁速或暂停；窗口失焦时 Unity 降频
   （实测 2 分钟仅推进约 0.1 游戏小时）。判断"卡死"须同时看 focused。
9. 回仓 mounted=false 的误解：该字段仅表示下单瞬间是否在车上；步行回仓只卸身上
   物资，车与后备箱留在原地。
10. 覆盖玩家手点指令的风险：玩家会产生 MoveToClickableOrder，replace_orders=true
    会顶掉玩家意图。检测到玩家指令应让出并确认。

三、玩法/资源类
11. 缺枪：居民楼搜刮基本只出罐头/工具/药品；新建小队会把库存手枪消耗掉
    （本次 8→1）。枪主要来自匪帮战利品、军警类建筑、工坊制造；不要用 4 人队
    硬打 8 人以上匪帮（换血亏，阵亡永久）。
12. 天气/月相无桥接接口：改为读存档 data.json 的 WeatherControllerSerialized，
    封装 weather.mjs 与 get_weather；数据滞后最多约一个游戏日，满月周期 6 天。
13. 发展瓶颈：金属可由搜刮补到 200+，但砖/木头长期低位（23/2）；建造岗位空置
    300+（工人集中在研究与生产）。建议外勤优先补砖木，把停产生产建筑的工人
    转投大工地。

四、多智能体协作类
14. 监视器静默停止：队友回合结束后其后台 job 被回收，threat-latest.json 不再
    刷新才发现。改进：由 Lead 用 Start-Process 独立拉起脚本进程，队友只监督。
15. runtime 的 worksites 恒为空：只读运行时只轮询快层，不含 worksites/buildings。
    需要工地数据时用原生 MCP get_world_data(worksites)。

五、优先改进项
1. MapQuery 候选过滤增强（减少无效搜刮尝试）
2. 统一写执行器（pause+下单+还速收进 runtime exec-service）
3. 插件增加医疗接口（目前无"用药回血"，只能回总部靠游戏治疗）
4. runtime 增加 weather 类目（直接读存档天气缓存）

================================================================
v0.2.2 工具补充（2026-11-12）
================================================================
- 看全局：observe / get_daily_report（一次聚合，优先于多次 get_world_data）
- 任务真做：get_missions 看目标进度与标记 -> get_mission_plan 拿可执行下一步；
  作弊完成（cheat_complete_mission(s)）只做紧急兜底，默认按计划实际执行。
- 建筑物资：进楼前用 find_buildings_by_poi / get_building_info 的 poi_icons 判断图标
  （Gun/Fuel/Drugs/Tools/Metal/Warehouse…，与游戏地图图标同 OSM 规则）；
  进楼后 get_building_info / get_scavenge_progress 可读剩余物资与进度。
- 地形：get_terrain_grid 一次拿水面/道路/桥/高程（比逐点 get_navigation_point 快百倍）；
  plan_route 直接给路线、距离与过桥格数。
- 远征：先在游戏里打开世界地图，再 get_expedition_tiles / get_expedition_summary。
- 车辆：get_world_data(vehicles) 只看已发现；get_vehicle_map 看全图（含未发现废车）。
- 敌情：get_enemy_report + get_infected_types（自爆/阿尔法/巨兽/强化变体识别）
  + get_combat_estimate（火力比与进攻/撤退建议）。
- 进度：get_progression 读存档 232 项解锁（巨兽/自爆/阿尔法为后期解锁，感染鸟无生成项）。
- 暂停：diagnose_pause 区分弹窗/面板/手动/失焦；wait_unpaused 下单前等待。
