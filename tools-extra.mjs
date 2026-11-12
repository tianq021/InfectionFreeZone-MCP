// 扩展 MCP 工具（复合/本地工具）
//
// 这些工具不新增游戏桥接方法，而是在 Node 侧组合现有桥接调用并做聚合分析，
// 因此不需要重新编译插件或重启游戏即可使用。
//
// 设计约定：
// - 每个工具返回结构化对象；失败返回 { ok:false, code, message }，不抛给客户端
// - 桥接类工具内部调用 request(method, args)（与 server.mjs 共用同一管道协议）
// - 本地类工具（存档/天气）直接读磁盘，桥接离线也能用

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getWeather } from "./weather.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HQ_FALLBACK = { x: 1331.2, z: 1478.3 };

export const RESOURCE_THRESHOLDS = {
  res_metal: 30,
  res_bricks: 30,
  res_wood: 20,
  res_drugs: 10,
  res_cans: 60,
  res_ammo: 40,
  res_fuel: 20,
  res_grain: 20,
  res_basic_tool: 20,
};

const RESOURCE_LABELS = {
  res_metal: "金属",
  res_bricks: "砖",
  res_wood: "木头",
  res_drugs: "药品",
  res_cans: "罐头",
  res_ammo: "弹药",
  res_fuel: "燃油",
  res_grain: "谷物",
  res_basic_tool: "工具",
};

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** 平面距离（x/z）。 */
export function planarDistance(ax, az, bx, bz) {
  return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
}

function callResult(request, method, args = {}) {
  return request(method, args);
}

async function getSessionState(request) {
  const state = await callResult(request, "get_state");
  if (!state || state.ok !== true) {
    throw Object.assign(new Error(state?.message ?? "get_state failed"), { code: state?.code ?? "state_unavailable" });
  }
  return state;
}

/** 按分页读取一个类目的全部条目。 */
export async function readAll(request, sessionId, category, { pageSize = 100, maxPages = 80 } = {}) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const reply = await callResult(request, "get_world_data", { session_id: sessionId, category, offset, limit: pageSize });
    if (!reply || reply.ok !== true) {
      throw Object.assign(new Error(reply?.message ?? `get_world_data(${category}) failed`), { code: reply?.code ?? "world_data_unavailable" });
    }
    if (Array.isArray(reply.items)) items.push(...reply.items);
    if (reply.next_offset == null) break;
    offset = reply.next_offset;
    if (!Array.isArray(reply.items) || reply.items.length === 0) break;
  }
  return items;
}

function isHostileFaction(faction) {
  return faction === "Infected" || faction === "Bandits";
}

/** 计算敌群威胁清单（纯函数，便于测试）。 */
export function summarizeThreats(groups, { hq = HQ_FALLBACK, squads = [], maxDistance = 1200 } = {}) {
  const playerSquads = squads.filter((squad) => Array.isArray(squad.members));
  const threats = [];
  for (const group of groups ?? []) {
    if (!isHostileFaction(group.faction)) continue;
    const dx = (group.position?.x ?? 0) - hq.x;
    const dz = (group.position?.z ?? 0) - hq.z;
    const distHq = round(planarDistance(group.position?.x ?? 0, group.position?.z ?? 0, hq.x, hq.z));
    const destDistHq = round(
      planarDistance(group.destination?.x ?? group.position?.x ?? 0, group.destination?.z ?? group.position?.z ?? 0, hq.x, hq.z),
    );
    const closing = destDistHq < distHq - 20;
    const moving =
      Math.abs((group.destination?.x ?? 0) - (group.position?.x ?? 0)) > 20 ||
      Math.abs((group.destination?.z ?? 0) - (group.position?.z ?? 0)) > 20;
    let nearestSquad = null;
    for (const squad of playerSquads) {
      const d = planarDistance(
        group.position?.x ?? 0,
        group.position?.z ?? 0,
        squad.position?.x ?? 0,
        squad.position?.z ?? 0,
      );
      if (!nearestSquad || d < nearestSquad.distance) {
        nearestSquad = { squadId: squad.id, name: squad.name, distance: round(d) };
      }
    }
    if (distHq > maxDistance && (!nearestSquad || nearestSquad.distance > maxDistance)) continue;
    threats.push({
      groupId: group.id,
      type: group.type ?? null,
      faction: group.faction,
      members: group.member_count ?? null,
      position: { x: round(group.position?.x ?? 0), z: round(group.position?.z ?? 0) },
      distanceToHq: distHq,
      destinationDistanceToHq: destDistHq,
      moving,
      closing,
      visible: Boolean(group.visible),
      hostileToPlayer: Boolean(group.hostile_to_player),
      nearestSquad,
      direction: compass(dx, dz),
    });
  }
  threats.sort((a, b) => a.distanceToHq - b.distanceToHq);
  return {
    count: threats.length,
    closingCount: threats.filter((t) => t.closing).length,
    movingCount: threats.filter((t) => t.moving).length,
    nearest: threats.slice(0, 12),
  };
}

/** 方位描述（z 增大为南，x 增大为东）。 */
export function compass(dx, dz) {
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0=北
  const normalized = (angle + 360) % 360;
  const labels = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return labels[Math.round(normalized / 45) % 8];
}

/** 经济与岗位摘要（纯函数）。 */
export function summarizeEconomy(stockpile, worksites, { thresholds = RESOURCE_THRESHOLDS } = {}) {
  const physical = {};
  for (const entry of stockpile ?? []) {
    if (entry.storage !== "physical") continue;
    physical[entry.resource_id] = round(entry.quantity, 2);
  }
  const shortfalls = [];
  for (const [id, threshold] of Object.entries(thresholds)) {
    const quantity = physical[id] ?? 0;
    if (quantity < threshold) {
      shortfalls.push({
        resourceId: id,
        label: RESOURCE_LABELS[id] ?? id,
        quantity,
        threshold,
        gap: round(threshold - quantity, 2),
      });
    }
  }
  const idle = [];
  const working = [];
  for (const site of worksites ?? []) {
    if (!site.work) continue;
    const entry = {
      buildingId: String(site.building_id),
      work: site.work,
      workers: site.workers ?? 0,
      maxWorkers: site.max_workers ?? 0,
      position: site.position ? { x: round(site.position.x), z: round(site.position.z) } : null,
    };
    if (entry.maxWorkers > 0 && entry.workers === 0) idle.push(entry);
    else if (entry.workers > 0) working.push(entry);
  }
  idle.sort((a, b) => b.maxWorkers - a.maxWorkers);
  const idleCapacity = idle.reduce((sum, site) => sum + site.maxWorkers, 0);
  return {
    stockpile: physical,
    shortfalls,
    idleSites: idle.slice(0, 12),
    idleSiteCount: idle.length,
    idleCapacity,
    activeSites: working.length,
  };
}

/** 任务摘要（纯函数）。 */
export function summarizeEvents(events) {
  const missions = [];
  const triggered = [];
  for (const entry of events ?? []) {
    if (entry.kind === "mission") {
      missions.push({
        id: entry.id,
        titleKey: entry.title_key ?? null,
        objectives: (entry.objectives ?? []).map((objective) => ({
          id: objective.id,
          type: objective.type ?? null,
          completed: Boolean(objective.completed),
        })),
        markers: entry.markers ?? [],
      });
    } else if (entry.kind === "event") {
      triggered.push(entry.id);
    }
  }
  return {
    missionCount: missions.length,
    missions,
    triggeredEventCount: triggered.length,
    triggeredEvents: triggered.slice(-30),
  };
}

/** 小队与车辆摘要（纯函数）。 */
export function summarizeSquads(squads, vehicles) {
  const byOwner = new Map();
  for (const vehicle of vehicles ?? []) {
    if (vehicle.owner_group_id) byOwner.set(String(vehicle.owner_group_id), vehicle);
  }
  return (squads ?? []).map((squad) => {
    const hp = (squad.members ?? []).map((member) => member.hp ?? 0);
    const vehicle = byOwner.get(String(squad.id)) ?? null;
    return {
      id: squad.id,
      name: squad.name,
      position: { x: round(squad.position?.x ?? 0), z: round(squad.position?.z ?? 0) },
      order: squad.active_order ?? null,
      idle: Boolean(squad.idle),
      inVehicle: Boolean(squad.in_vehicle),
      vehicleId: squad.vehicle_id ?? null,
      minHp: hp.length ? Math.min(...hp) : null,
      members: (squad.members ?? []).length,
      cargo: squad.cargo ?? {},
      vehicle: vehicle
        ? {
            id: vehicle.id,
            type: vehicle.type,
            loadRatio: round(vehicle.trunk?.load_ratio ?? 0, 2),
            fuelRatio: round(vehicle.fuel?.ratio ?? 0, 2),
            cargo: vehicle.trunk?.cargo ?? {},
          }
        : null,
    };
  });
}

/** 生成可执行建议（纯函数，启发式）。 */
export function buildRecommendations({ economy, threats, squads }) {
  const recommendations = [];
  const closing = threats?.closingCount ?? 0;
  const nearest = threats?.nearest?.[0] ?? null;
  if (closing > 0) {
    recommendations.push({
      priority: "high",
      action: "回防",
      detail: `有 ${closing} 个敌群朝聚落移动，最近 ${nearest?.groupId}（${nearest?.members} 只，${nearest?.distanceToHq} m，${nearest?.direction}）`,
    });
  } else if (nearest && nearest.distanceToHq < 500) {
    recommendations.push({
      priority: "medium",
      action: "警戒",
      detail: `敌群 ${nearest.groupId}（${nearest.members} 只）距总部 ${nearest.distanceToHq} m，尚未推进`,
    });
  }
  for (const item of (economy?.shortfalls ?? []).slice(0, 3)) {
    recommendations.push({
      priority: item.gap > item.threshold ? "high" : "medium",
      action: "补资源",
      detail: `${item.label} 仅 ${item.quantity}（低于 ${item.threshold}，缺 ${item.gap}）`,
    });
  }
  const idleCapacity = economy?.idleCapacity ?? 0;
  if (idleCapacity >= 60) {
    recommendations.push({
      priority: "medium",
      action: "调岗位",
      detail: `有 ${economy.idleSiteCount} 个工地空置、合计 ${idleCapacity} 个岗位，建议把停产生产建筑的工人调去建造`,
    });
  }
  const hurt = (squads ?? []).filter((squad) => squad.minHp != null && squad.minHp < 60);
  if (hurt.length) {
    recommendations.push({
      priority: "high",
      action: "撤退治疗",
      detail: `${hurt.map((squad) => squad.id).join(", ")} 有队员血量低于 60，应撤回总部治疗`,
    });
  }
  if (!recommendations.length) {
    recommendations.push({ priority: "low", action: "保持", detail: "无紧急事项，继续发展与巡逻即可" });
  }
  return recommendations;
}

function newestSaveInfo() {
  const roots = ["C:\\Users\\hp\\AppData\\LocalLow\\JutsuGames\\Infection Free Zone", path.join(here, ".local", "test-data")];
  for (const root of roots) {
    const savesDir = path.join(root, "Saves");
    let entries = [];
    try {
      entries = fs.readdirSync(savesDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(savesDir, entry.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(dir, "info.json")).mtimeMs;
        } catch {
          // ignore
        }
        return { name: entry.name, dir, mtime };
      })
      .filter((entry) => entry.mtime > 0)
      .sort((a, b) => b.mtime - a.mtime);
    if (!dirs.length) continue;
    const newest = dirs[0];
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(path.join(newest.dir, "info.json"), "utf8"));
    } catch {
      info = null;
    }
    return {
      saveRoot: root,
      saveName: newest.name,
      updatedAt: new Date(newest.mtime).toISOString(),
      info,
    };
  }
  return null;
}

/**
 * 注册扩展工具。
 * @param {object} options
 * @param {(name:string, description:string, schema:object, handler:Function)=>void} options.registerLocal
 * @param {(method:string, args:object)=>Promise<any>} options.request
 * @param {boolean} [options.readOnly]
 */
export function registerExtraTools({ registerLocal, request, readOnly = false }) {
  const bridgeOk = (result) => result && result.ok === true;

  registerLocal(
    "observe",
    "Composite snapshot: game time, HQ, squads with vehicles, stockpile, hostile summary and weather in one call. Aggregates several bridge reads (no extra plugin support needed).",
    {
      include_groups: z.boolean().optional().describe("Include hostile group summary (default true)"),
      max_threat_distance: z.number().min(100).max(4000).optional().describe("Only report hostiles within this distance of HQ (default 1200)"),
    },
    async (args) => {
      const state = await getSessionState(request);
      const sessionId = state.session_id;
      const [squads, vehicles, stockpile, groups] = await Promise.all([
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, "vehicles"),
        readAll(request, sessionId, "stockpile"),
        args.include_groups === false ? Promise.resolve([]) : readAll(request, sessionId, "groups"),
      ]);
      const hq = state.headquarters ? { x: state.headquarters.x, z: state.headquarters.z } : HQ_FALLBACK;
      const economy = summarizeEconomy(stockpile, []);
      return {
        ok: true,
        sessionId,
        time: state.time,
        headquarters: hq,
        squads: summarizeSquads(squads, vehicles),
        stockpile: economy.stockpile,
        shortfalls: economy.shortfalls,
        threats: args.include_groups === false ? null : summarizeThreats(groups, { hq, squads, maxDistance: args.max_threat_distance ?? 1200 }),
        weather: getWeather(),
      };
    },
  );

  registerLocal(
    "get_threats",
    "List hostile groups with distance/direction to HQ and to player squads, plus whether they are moving toward the settlement. Hidden groups are included by default.",
    {
      max_distance: z.number().min(100).max(4000).optional().describe("Distance filter from HQ (default 1200)"),
      include_hidden: z.boolean().optional().describe("Include groups the player has not discovered (default true)"),
      limit: z.number().int().min(1).max(40).optional().describe("Max rows returned (default 12)"),
    },
    async (args) => {
      const state = await getSessionState(request);
      const sessionId = state.session_id;
      const [squads, groups] = await Promise.all([readAll(request, sessionId, "squads"), readAll(request, sessionId, "groups")]);
      const hq = state.headquarters ? { x: state.headquarters.x, z: state.headquarters.z } : HQ_FALLBACK;
      const includeHidden = args.include_hidden !== false;
      const filtered = includeHidden ? groups : groups.filter((group) => group.visible);
      const summary = summarizeThreats(filtered, { hq, squads, maxDistance: args.max_distance ?? 1200 });
      summary.nearest = summary.nearest.slice(0, args.limit ?? 12);
      return { ok: true, time: state.time, headquarters: hq, ...summary };
    },
  );

  registerLocal(
    "get_economy",
    "Resource shortfalls versus development thresholds plus worksite staffing (idle construction jobs) in one call.",
    {
      include_worksites: z.boolean().optional().describe("Include worksite staffing analysis (default true)"),
    },
    async (args) => {
      const state = await getSessionState(request);
      const sessionId = state.session_id;
      const [stockpile, worksites] = await Promise.all([
        readAll(request, sessionId, "stockpile"),
        args.include_worksites === false ? Promise.resolve([]) : readAll(request, sessionId, "worksites"),
      ]);
      const economy = summarizeEconomy(stockpile, worksites);
      return { ok: true, time: state.time, thresholds: RESOURCE_THRESHOLDS, ...economy };
    },
  );

  registerLocal(
    "get_squads_report",
    "Squad roster with orders, health, cargo, assigned vehicle, trunk load and fuel in one call.",
    {},
    async () => {
      const state = await getSessionState(request);
      const sessionId = state.session_id;
      const [squads, vehicles] = await Promise.all([readAll(request, sessionId, "squads"), readAll(request, sessionId, "vehicles")]);
      return { ok: true, time: state.time, squads: summarizeSquads(squads, vehicles) };
    },
  );

  registerLocal(
    "get_events_report",
    "Active missions with objective completion and a list of triggered events, condensed.",
    {},
    async () => {
      const state = await getSessionState(request);
      const sessionId = state.session_id;
      const events = await readAll(request, sessionId, "events");
      return { ok: true, time: state.time, ...summarizeEvents(events) };
    },
  );

  registerLocal(
    "get_save_info",
    "Local save metadata (newest save name, in-game day/time text, city) plus weather and moon phase. Works even when the game bridge is offline.",
    {},
    async () => {
      const save = newestSaveInfo();
      return {
        ok: Boolean(save),
        ...(save ?? { message: "没有找到存档目录" }),
        weather: getWeather(),
      };
    },
  );

  registerLocal(
    "get_map_info",
    "Map bounds, tile size and city name from the running game.",
    {},
    async () => {
      const state = await getSessionState(request);
      const sessionId = state.session_id;
      const map = await readAll(request, sessionId, "map");
      return { ok: true, map: map[0] ?? null };
    },
  );

  registerLocal(
    "get_recommendations",
    "Heuristic action list for the AI squad leader: defend, resupply, reassign workers, retreat wounded.",
    {},
    async () => {
      const state = await getSessionState(request);
      const sessionId = state.session_id;
      const [squads, vehicles, stockpile, worksites, groups] = await Promise.all([
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, "vehicles"),
        readAll(request, sessionId, "stockpile"),
        readAll(request, sessionId, "worksites"),
        readAll(request, sessionId, "groups"),
      ]);
      const hq = state.headquarters ? { x: state.headquarters.x, z: state.headquarters.z } : HQ_FALLBACK;
      const squadSummary = summarizeSquads(squads, vehicles);
      const economy = summarizeEconomy(stockpile, worksites);
      const threats = summarizeThreats(groups, { hq, squads, maxDistance: 1200 });
      return {
        ok: true,
        time: state.time,
        recommendations: buildRecommendations({ economy, threats, squads: squadSummary }),
      };
    },
  );

  registerLocal(
    "bridge_probe",
    "Measure round-trip latency of the game bridge and report session readiness.",
    { samples: z.number().int().min(1).max(10).optional().describe("Number of status calls (default 3)") },
    async (args) => {
      const samples = [];
      for (let i = 0; i < (args.samples ?? 3); i++) {
        const started = Date.now();
        const reply = await request("status", {});
        samples.push({ ms: Date.now() - started, ready: Boolean(reply?.ready), scene: reply?.scene ?? null, ok: bridgeOk(reply) });
      }
      const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
      return {
        ok: true,
        samples,
        minMs: latencies[0] ?? null,
        medianMs: latencies[Math.floor(latencies.length / 2)] ?? null,
        maxMs: latencies[latencies.length - 1] ?? null,
      };
    },
  );

  if (!readOnly) {
    registerLocal(
      "export_snapshot",
      "Write a JSON snapshot of the current world (time, squads, threats, economy) to .local/snapshots/ and return the file path. Read-only with respect to the game.",
      { label: z.string().min(1).max(40).optional().describe("Optional snapshot label placed in the filename") },
      async (args) => {
        const state = await getSessionState(request);
        const sessionId = state.session_id;
        const [squads, vehicles, stockpile, worksites, groups] = await Promise.all([
          readAll(request, sessionId, "squads"),
          readAll(request, sessionId, "vehicles"),
          readAll(request, sessionId, "stockpile"),
          readAll(request, sessionId, "worksites"),
          readAll(request, sessionId, "groups"),
        ]);
        const hq = state.headquarters ? { x: state.headquarters.x, z: state.headquarters.z } : HQ_FALLBACK;
        const snapshot = {
          at: new Date().toISOString(),
          sessionId,
          time: state.time,
          headquarters: hq,
          squads: summarizeSquads(squads, vehicles),
          economy: summarizeEconomy(stockpile, worksites),
          threats: summarizeThreats(groups, { hq, squads, maxDistance: 4000 }),
          weather: getWeather(),
        };
        const dir = path.join(here, ".local", "snapshots");
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const label = args.label ? `-${args.label.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
        const file = path.join(dir, `snapshot-${stamp}${label}.json`);
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8");
        return { ok: true, file, bytes: fs.statSync(file).size, time: state.time };
      },
    );
  }
}

export { newestSaveInfo };
