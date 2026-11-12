import { z } from "zod";

const id = z.string().min(1).max(80);
const uuid = z.string().uuid();
const quantity = z.number().positive().max(1000000);
const count = z.number().int().min(1).max(12).optional();
const point = { x: z.number().finite(), z: z.number().finite() };
const categories = ["resources", "weapons", "units", "world", "missions"];
const actions = new Map([
  ["add_resources", { category: "resources", note: "增加共享库存资源",
    params: { resource_id: id.startsWith("res_"), quantity }, args: "resource_id, quantity" }],
  ["give_weapon", { category: "weapons", note: "向共享库存发放指定武器",
    params: { weapon_id: id.startsWith("eq_"), quantity: z.number().int().min(1).max(1000) },
    args: "weapon_id, quantity" }],
  ["refill_ammo", { category: "weapons", note: "补满玩家小队弹药" }],
  ["heal_squads", { category: "units", note: "治疗玩家小队" }],
  ["spawn_squad", { category: "units", note: "生成玩家小队",
    params: { ...point, count, vehicle: id.optional() }, args: "x, z, count?=4, vehicle?=ve_sedan" }],
  ["spawn_infected", { category: "units", note: "生成一组可见的普通感染者",
    params: { ...point, count }, args: "x, z, count?=1" }],
  ["reveal_groups", { category: "units", note: "揭示地图上的现有群组" }],
  ["unlock_expedition", { category: "world", note: "解锁远征地块" }],
  ["scavenge_all", { category: "world", note: "将全地图废弃建筑标记为已搜刮" }],
  ["set_time", { category: "world", note: "设置日期、小时或速度，至少填一项",
    params: { day: z.number().int().min(1).max(10000).optional(),
      hour: z.number().int().min(0).max(23).optional(), speed: z.number().min(0).max(100).optional() },
    args: "day?, hour?, speed?" }],
  ["complete_mission", { category: "missions", note: "完成一项进行中的任务",
    params: { mission_id: id }, args: "mission_id" }],
  ["complete_missions", { category: "missions", note: "完成全部进行中的任务" }],
]);

const error = (code, message) => ({ ok: false, code, message });

export function registerCheatTools({ registerLocal, request }) {
  registerLocal("cheat_catalog", "List cheat categories, or the actions in one category. Specify an action for its arguments.", {
    category: z.enum(categories).optional(), action: id.optional(),
  }, async ({ category, action }) => {
    if (action) {
      const entry = actions.get(action);
      if (!entry || (category && category !== entry.category)) return error("unknown_cheat", "查不到此作弊动作。");
      return { ok: true, action, category: entry.category, note: entry.note, args: entry.args ?? "" };
    }
    if (!category) return { ok: true, categories };
    return { ok: true, category, actions: [...actions]
      .filter(([, entry]) => entry.category === category)
      .map(([name, entry]) => ({ action: name, note: entry.note })) };
  });

  registerLocal("cheat_apply", "Run one cheat requested by the player. Read cheat_catalog for parameters. Requires gameplay pause. Reuse request_id on retry.", {
    action: id,
    params: z.record(z.string(), z.unknown()).optional(),
    session_id: uuid,
    request_id: uuid,
  }, async ({ action, params, session_id, request_id }) => {
    const entry = actions.get(action);
    if (!entry) return error("unknown_cheat", "先使用 cheat_catalog 查询动作。");
    const parsed = z.strictObject(entry.params ?? {}).safeParse(params ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return error("invalid_cheat_params", [issue.path.join("."), issue.message].filter(Boolean).join(" ").slice(0, 180));
    }
    if (action === "set_time" && !Object.keys(parsed.data).length)
      return error("invalid_cheat_params", "提供 day、hour 或 speed。");
    const control = await request("acquire_control", { owner: "IFZ MCP cheats" });
    if (!control.ok) return control;
    let result;
    let released;
    try {
      result = await request("cheat_apply", { action, params: parsed.data, session_id, request_id, lease: control.lease });
    } finally {
      released = await request("release_control", { lease: control.lease }).catch(() => null);
    }
    if (result.code === "unknown_method")
      return error("plugin_upgrade_required", "安装当前 IfzMcp.dll 并重新启动游戏。");
    if (!result.ok) return result;
    const { wounded, objectives, ...summary } = result;
    return { ...summary, action, request_id, ...(wounded && { wounded_count: wounded.length }),
      ...(!released?.ok && { control_released: false }) };
  });
}
