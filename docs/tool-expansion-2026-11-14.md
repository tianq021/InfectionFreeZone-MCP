# 游戏 MCP 工具分析与扩展（2026-11-14）

本轮新增 **32 个只读工具**：23 个基于既有桥接的复合/目录工具，9 个新增原生桥接工具。默认注册数从 94 增至 **126**。保留现有订单、租约、暂停和幂等写入机制。

同日第二批另新增 6 个原生查询，当前默认总数为 **132**；见 [NPC 聚落与大远征查询](npc-convoy-tools.md)。本文中的 126/93/99 等计数保留第一批验证时的历史状态。

## 分析与实现选择

原有工具已覆盖小队命令、搜刮、地图、敌情、建造和设施管理。主要缺口是：科研与法令等聚落系统缺少专门数据接口；库存、货物、工作任务等数据虽然可以读到，却需要调用者反复拼接才能回答“缺什么、在哪里、为什么停工”。

本轮复用已有 BepInEx 主线程桥接、Node MCP SDK 和真实分页数据。原生缺口通过类型明确的 C# API 补齐，分析工具在 Node 侧聚合。没有引入另一套游戏控制服务或新增 npm 依赖。

前人方案核对：

- [JaySNL/IFZMods](https://github.com/JaySNL/IFZMods) 采用同游戏的 BepInEx/Harmony 模组路线，支持继续沿用本项目现有插件架构的选择。
- [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) 主要连接 Unity Editor，适合作为工具设计参考，不能直接替代本项目运行中的零售游戏桥接。
- [MCP 官方工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 提供工具发现、输入 schema、结构化输出和错误约定；新增工具都标记 `readOnlyHint: true`、`destructiveHint: false`、`openWorldHint: false`。标记只是元数据，实际只读性由调用路径保证。

## 新增工具清单

### 原生聚落数据：9 项

需要包含 `SettlementIntel.cs` 的新版插件。均要求当前 `session_id`；列表支持 `offset`、`limit`（1–100）及 `next_offset`。

| 工具 | 能回答的问题 |
|---|---|
| `get_research_status` | 正在研究什么、科研材料和科学家有多少？ |
| `get_research_catalog` | 科技/旧版法令的成本、依赖、状态和进度？支持 `group`、`state` 筛选。 |
| `get_laws` | 当前现代法令、集会状态、粮食消耗和工时修正是什么？ |
| `get_housing` | 住房容量、入住、分配偏好和无家可归人数？ |
| `get_storage_capacity` | 全局仓储容量、占用、预留和各仓库的容量贡献？ |
| `get_population_health` | 平民与小队成员的疾病、治疗、饥饿、疲劳和伤势？ |
| `get_food_status` | 可食库存、原料、消耗配置和腐败批次？附带明确假设的库存天数估算。 |
| `get_resource_definitions` | 资源原生名称、类型、每箱数量、交易与拆解定义？ |
| `get_resource_flows` | 本游戏日和上日的生产、搜刮与移除请求计数？ |

`get_research_status`、`get_laws`、`get_food_status` 返回完整的小型摘要，不需要分页参数。`get_resource_definitions` 和 `get_resource_flows` 可按 `resource_id` 筛选。

### 资源与物流：8 项

| 工具 | 能回答的问题 |
|---|---|
| `get_stockpile_report` | 物理/虚拟库存分别有多少，多少可用或因交换而暂不可用？ |
| `get_resource_catalog` | 现有桥接公开哪些资源 ID，武器使用什么弹药？ |
| `get_resource_budget` | 指定物资预算能否由一个库存容器承担，缺口是多少？ |
| `get_resource_locations` | 某种物资在地面、小队、车辆中的位置？ |
| `get_ground_resources_report` | 地面散落资源的数量、距离和最近仓库？ |
| `get_storage_report` | 哪些共享仓库可作为归仓入口，最近的小队是谁？ |
| `get_supply_network` | 哪些工作地点距离仓库最远？ |
| `get_cargo_manifest` | 哪些物资仍由小队或车辆携带、尚未归仓？ |

`get_resource_catalog` 使用旧桥接已有信息，可兼容旧插件；`get_resource_definitions` 是完整原生定义查询。两者用途和部署要求不同。

### 运营与派工：8 项

| 工具 | 能回答的问题 |
|---|---|
| `get_production_bottlenecks` | 哪些生产设施缺料、无人、暂停或当前没有工人工作？ |
| `get_recipe_catalog` | 已完成设施有哪些可选配方及每周期投入产出？ |
| `get_production_capacity` | 当前配方按每活跃游戏小时计算的理论吞吐？ |
| `get_healthcare_report` | 医生、床位与去重后的伤员概况？ |
| `get_defense_report` | 城防是否缺守卫、选中武器或库存弹药？ |
| `get_workforce_plan` | 保留一部分空闲工人后，可以怎样分配其余人数？ |
| `get_construction_queue` | 当前原生施工/改造任务有哪些、是否缺人？可包含维修拆除。 |
| `get_settlement_alerts` | 暂停、天气、情绪、生产和工作状态有哪些值得关注的信号？ |

派工工具只提供建议和 `expected_value`，不执行写入。优先级模式由游戏调度，不伪造直接分配建议。

### 小队与查询：7 项

| 工具 | 能回答的问题 |
|---|---|
| `get_squad_readiness` | 小队是否低血、缺弹、车辆低油或数据不完整？ |
| `get_wounded_report` | 哪些活着的角色受伤最重？对重叠名册去重。 |
| `get_ammo_supply_report` | 哪些弹种有空弹药使用者，物理可用库存还有多少？ |
| `get_nearby_entities` | 指定坐标附近有哪些小队、群组、车辆、仓库和资源？ |
| `get_return_options` | 小队最近的归仓点有哪些，附近有多少已确认敌群？ |
| `get_mission_deadlines` | 当前任务的原生剩余时间、章节和目标完成数？ |
| `get_tool_catalog` | 当前配置实际启用了哪些工具、参数和数据入口？离线也可查询。 |

## 输出与准确性边界

- `tools-query.mjs` 统一检查会话、桥接错误、分页数组和递增游标；最多读取 80 页，超限报错，不把截断数据作为完整报告。组合查询是连续的实时读取，不保证同一模拟帧的原子快照。
- 分析结果默认最多返回 30 项，可用 `limit` 调至 100；提供总数和截断标记。全局汇总通常基于截断前的数据，具体以字段说明为准。
- `get_settlement_alerts` 可保留部分成功数据，但必须返回 `partial` 和 `source_errors`；会话切换直接失败。
- 物理与虚拟库存不混加；仓库共享库存，不能据仓库入口编造独立库存分布。小队背包与车辆后备箱是不同原生容器。
- 库存 `available` 是游戏减去交换中数量后的可用量，不代表已扣除所有未来施工需求。仓库 `occupied_or_locked_slots` 包含已占用或锁定的槽位，不应当成实际物资数量；虚拟容器的容量/负剩余值不代表实体仓库不足。
- 距离是 X/Z 平面直线距离，不保证可通行；实际路线仍用 `plan_route`。未知坐标不会替换成地图原点。
- 群组敌意采用桥接的 `hostile_to_player`，不会仅凭 Bandits 阵营判定敌人；隐藏群组默认不出现在附近实体查询中。
- `get_production_capacity` 是每活跃游戏小时的理论值，不含班次、搬运、停工、缺料和库满。库存低于整周期投入，也不证明材料已经送达的当前批次停工。
- 研究进度单位是原生工作量，不当成小时。任务时间字段保持原生单位，不推算未核实的现实时间期限。
- 游戏 `used` 流水会累计失败的移除请求，因此 `get_resource_flows` 是原生记账查询，不能当作精确实际消耗。`tracked_net` 也不保证等于库存变化。

## 使用与验证

注册清单实测：默认 **126**；`--read-only` **93**；`--workforce-only --allow-construction` **99**；`--enable-cheats` **117**（沿用原有聚合作弊注册策略）。

```powershell
npm test
npm run tools:list
npm run tools:list -- --read-only
node client.mjs --steam get_tool_catalog '{"query":"research"}'
node client.mjs --steam get_resource_budget '{"requirements":[{"resource_id":"res_wood","quantity":40}]}'
node client.mjs --steam get_workforce_plan '{"reserve_workers":5}'
```

原生接口示例：先调用 `get_state` 获取 `session_id`，再调用 `get_research_status` 或其他原生查询。复合工具自行获取当前会话。

本轮 `npm test` 全部 **87 项通过**，包括行为测试及实际 MCP stdio 握手、注册、schema 和模式过滤测试。CLI 目录搜索可正常离线使用，复合与原生实时查询在游戏离线时均正确返回 `bridge_offline`。插件使用本地 SDK 编译通过（0 错误；3 项既有警告：System.Net.Http 版本引用冲突和 2 项过时 API），目标仍为 Steam build 26104777。编译产物位于 `plugin/bin/Release/netstandard2.1/IfzMcp.dll`，没有复制到 Steam 游戏目录。

本轮检查时 Steam 桥接返回 `bridge_offline`，因此**原生工具尚未实机验证**。23 项复合/目录工具重连 MCP 服务后可被客户端发现；其中实时分析仍需游戏在线。9 项原生查询还需要按 README 的插件更新流程部署新 DLL 并重新启动游戏。旧插件会对这些方法返回 `unknown_method`，不能把“已注册”理解为“已部署”。

## 下一批值得增加的操作能力

以下已经找到原生候选 API，但本轮没有作为已完成工具发布：

| 能力 | 原生候选入口 | 还需验证 |
|---|---|---|
| 开始/取消科技研究 | `Research.HandleResearchButtonClick` / `HandleCancelClick` | 资源支付、当前研究冲突、解锁及幂等重试 |
| 颁布法令 | `LawsController.SetLaw` | 集会完成、每日次数、前置限制及原生 UI 的校验顺序 |
| 维修预览与下单 | `Structure.GetRepairCost` / `GetTimeToRepair` / `StartRepairing` | 施工冲突、费用、工作任务生成、原生回执 |
| 拆除收益预览与执行 | `Structure.GetPossibleDeconstructionProfit` | 占用人口/物资、不可逆损失及订单生命周期 |
| 研究设施效率 | `ResearchWork.ScientificMaterialsProgress` / `GetWorkersNumber` | 生产效率单位与完整设施枚举 |

这些写操作应继续复用现有租约、原生校验、请求 ID 和回执机制，不直接调用底层 setter 绕过玩法限制。
