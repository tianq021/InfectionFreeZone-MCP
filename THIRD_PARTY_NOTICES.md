# 第三方许可证与游戏知识产权说明

本仓库的 **源代码与文档** 采用 [PolyForm Noncommercial 1.0.0](LICENSE)：允许下载、修改、非商业使用与再分发（需保留许可与版权声明），**不允许商业用途**。

以下第三方组件/资源各自保留其原始许可证；本仓库不改变、也不重新许可它们。

## 运行时依赖（Node.js）

| 组件 | 用途 | 许可证 |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP 服务端/stdio 传输 | MIT |
| `zod` | 参数校验 | MIT |
| `ws` | WebSocket（运行时） | MIT |

## 游戏侧依赖（不随仓库分发）

| 组件 | 用途 | 许可证 / 归属 |
|---|---|---|
| 《Infection Free Zone》游戏本体与资源 | 被桥接的游戏 | © JutsuGames；受游戏 EULA 约束 |
| `Ifz.dll` 及 `*_Data/Managed/*.dll` | 编译插件时的引用程序集 | © JutsuGames / 对应权利人 |
| BepInEx（`BepInEx.dll`、`0Harmony.dll`） | Unity 插件加载与 Harmony 补丁 | BepInEx: LGPL-2.1；0Harmony: MIT |
| Unity Engine 模块 | 游戏引擎 | © Unity Technologies，受 Unity 许可约束 |
| A* Pathfinding Project（`AstarPathfindingProject.dll`） | 游戏内寻路 | © Aron Granberg，按其商业许可 |
| Sirenix Odin / Zenject / Newtonsoft.Json | 游戏/插件依赖 | 各自原许可证（Odin 商业许可；Zenject/Json.NET 为 MIT） |

## 重要声明

1. **本仓库不包含游戏本体、游戏资源（地图/模型/音频）或 `Ifz.dll` 等商业程序集**；使用本项目需要你自行合法拥有《Infection Free Zone》。
2. 插件通过 BepInEx 在本地运行，仅在你自己的游戏进程中读写状态，不提供破解、绕过授权或分发游戏内容的能力。
3. 修改与再分发本项目代码时，请同时保留 [LICENSE](LICENSE) 与本说明文件。
4. 若将本项目或衍生作品用于商业目的（含付费分发、商业服务、企业内部商业运营等），需另行取得作者书面许可。
