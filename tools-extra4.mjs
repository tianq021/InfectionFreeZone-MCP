// 第四批复合工具：资源图标热点、远征汇总、任务行动计划。
// 组合现有桥接调用，不需要插件改动。
import { z } from "zod";
import { readAll } from "./tools-extra.mjs";

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

async function sessionState(request) {
  const state = await request("get_state", {});
  if (!state || state.ok !== true) {
    throw Object.assign(new Error(state?.message ?? "get_state failed"), { code: state?.code ?? "state_unavailable" });
  }
  return state;
}

const planar = (ax, az, bx, bz) => Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);

async function loadMapBuildings(request, sessionId) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 80; page++) {
    const reply = await request("get_map_buildings", { session_id: sessionId, scope: "full", offset, limit: 100 });
    if (!reply || reply.ok !== true) break;
    items.push(...(reply.items ?? []));
    if (reply.next_offset == null) break;
    offset = reply.next_offset;
  }
  return items;
}

export function registerTools4({ registerLocal, request, readOnly = false }) {
  registerLocal(
    "get_resource_hotspots",
    "One-call scan of buildings carrying resource icons: for each POI type (Gun/Fuel/Drugs/Tools/Metal/Warehouse/Food) show how many exist and the nearest few, using the same OSM icon rules as the game.",
    {
      radius: z.number().min(50).max(4000).optional().describe("Search radius from HQ (default 2000)"),
      types: z.array(z.string().min(1).max(20)).max(8).optional().describe("POI types (default Gun, Fuel, Drugs, Tools, Metal, Warehouse, Food)"),
      per_type: z.number().int().min(1).max(10).optional().describe("Nearest entries per type (default 3)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const types = args.types?.length ? args.types : ["Gun", "Fuel", "Drugs", "Tools", "Metal", "Warehouse", "Food"];
      const radius = args.radius ?? 2000;
      const perType = args.per_type ?? 3;
      const summary = [];
      for (const type of types) {
        const reply = await request("find_buildings_by_poi", {
          session_id: state.session_id,
          poi: [type],
          radius,
          limit: perType,
          only_scavengeable: true,
        });
        if (!reply || reply.ok !== true) {
          summary.push({ poi: type, error: reply?.message ?? "failed" });
          continue;
        }
        summary.push({
          poi: type,
          count: reply.matched_total ?? reply.count,
          nearest: (reply.results ?? []).map((row) => ({
            building_id: row.building_id,
            type: row.type,
            distance: row.distance,
            position: row.position,
          })),
        });
      }
      return { ok: true, time: state.time, radius, summary };
    },
  );

  registerLocal(
    "get_expedition_summary",
    "Expedition overview: loaded tile count, scavenged fraction, area/location type distribution, aggregated resource icons (Gun/Fuel/...) and the richest tiles. Open the world map in-game first.",
    {
      radius: z.number().min(0).max(6000).optional().describe("0 = all loaded tiles (default 0)"),
      limit: z.number().int().min(1).max(400).optional().describe("Analyse at most this many tiles (default 200)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const reply = await request("get_expedition_tiles", {
        session_id: state.session_id,
        radius: args.radius ?? 0,
        limit: args.limit ?? 200,
      });
      if (!reply || reply.ok !== true) {
        return { ok: false, code: reply?.code ?? "expedition_unavailable", message: reply?.message ?? "打开世界地图后再试" };
      }
      const tiles = reply.tiles ?? [];
      const byArea = {};
      const byLocation = {};
      const totals = {};
      let scavengable = 0;
      let enabled = 0;
      let inFog = 0;
      for (const tile of tiles) {
        byArea[tile.area_type] = (byArea[tile.area_type] ?? 0) + 1;
        byLocation[tile.location_type] = (byLocation[tile.location_type] ?? 0) + 1;
        if (tile.scavengable) scavengable++;
        if (tile.enabled) enabled++;
        if (tile.in_fog) inFog++;
        for (const [poi, count] of Object.entries(tile.poi_icons ?? {})) {
          totals[poi] = (totals[poi] ?? 0) + count;
        }
      }
      const richest = tiles
        .map((tile) => ({
          tile: `(${tile.tx},${tile.ty})`,
          distance: tile.distance,
          scavengable: tile.scavengable,
          poi_icons: tile.poi_icons,
          poi_total: Object.values(tile.poi_icons ?? {}).reduce((sum, value) => sum + value, 0),
        }))
        .sort((a, b) => b.poi_total - a.poi_total)
        .slice(0, 10);
      return {
        ok: true,
        time: state.time,
        loadedTiles: reply.total_loaded ?? tiles.length,
        scannedTiles: tiles.length,
        scavengedFraction: reply.scavenged_fraction ?? null,
        scavengable,
        enabled,
        inFog,
        byAreaType: byArea,
        byLocationType: byLocation,
        poiTotals: totals,
        richest,
        data: tiles,
      };
    },
  );

  registerLocal(
    "get_mission_plan",
    "For every active mission objective, produce concrete next actions from live data: which hostile groups to kill, buildings to scavenge/adapt, markers to visit, wounded squads to heal, idle worksites and sunset countdown. Complements get_missions (which lists objective types).",
    {},
    async () => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [missionsReply, squads, vehicles, groups, buildings, worksites] = await Promise.all([
        request("get_missions", { session_id: sessionId, include_types: false }),
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, "vehicles"),
        readAll(request, sessionId, "groups"),
        loadMapBuildings(request, sessionId),
        readAll(request, sessionId, "worksites"),
      ]);
      if (!missionsReply || missionsReply.ok !== true) {
        return { ok: false, code: missionsReply?.code ?? "missions_unavailable", message: missionsReply?.message ?? "任务读取失败" };
      }
      const hq = state.headquarters ?? { x: 0, z: 0 };
      const squadRows = (squads ?? []).map((squad) => ({
        id: squad.id,
        name: squad.name,
        position: squad.position,
        vehicle: (vehicles ?? []).find((vehicle) => String(vehicle.owner_group_id) === String(squad.id))?.type ?? null,
        minHp: Math.min(...(squad.members ?? []).map((member) => member.hp ?? 100), 100),
      }));
      const nearestSquad = (point) =>
        squadRows
          .map((squad) => ({ squadId: squad.id, distance: Math.round(planar(squad.position?.x ?? 0, squad.position?.z ?? 0, point?.x ?? 0, point?.z ?? 0)) }))
          .sort((a, b) => a.distance - b.distance)[0] ?? null;
      const hostileGroups = (groups ?? [])
        .filter((group) => group.faction === "Infected" || group.faction === "Bandits")
        .map((group) => ({
          groupId: group.id,
          type: group.type,
          faction: group.faction,
          members: group.member_count,
          lair: String(group.type ?? "").startsWith("hideout_"),
          position: group.position,
          distanceToHq: Math.round(planar(group.position?.x ?? 0, group.position?.z ?? 0, hq.x ?? 0, hq.z ?? 0)),
          nearestSquad: nearestSquad(group.position),
        }))
        .sort((a, b) => a.distanceToHq - b.distanceToHq);
      const scavengeable = (buildings ?? []).filter((building) => building?.can_scavenge && !building.scavenged && !building.stockroom);
      const idleSites = (worksites ?? []).filter((site) => (site.workers ?? 0) === 0 && (site.max_workers ?? 0) > 0);
      const wounded = squadRows.filter((squad) => squad.minHp < 60);
      const sunsetIn = state.time && typeof state.time.hour === "number" && typeof state.time.sunset === "number"
        ? Math.max(0, Math.round((state.time.sunset - state.time.hour) * 10) / 10)
        : null;

      const plans = [];
      for (const mission of missionsReply.missions ?? []) {
        if (!mission?.objectives) continue;
        const actions = [];
        for (const objective of mission.objectives) {
          if (objective.completed) continue;
          const type = objective.type;
          if (["KillCharacters", "DefeatInfected", "KillGroup", "ClearLair"].includes(type)) {
            const targets = (type === "ClearLair" ? hostileGroups.filter((group) => group.lair) : hostileGroups).slice(0, 3);
            actions.push({
              objective: objective.id,
              type,
              action: "击杀敌对群",
              targets,
              note: targets.length ? "用 attack_group 派最近的队伍进攻，攻击前先 get_combat_estimate 评估" : "当前没有可攻击的敌对群，先探索地图",
            });
          } else if (["ScavengeResource", "ScavengeResourceOnExpedition", "SendSquadToScavengeBuilding"].includes(type)) {
            const near = scavengeable
              .map((building) => ({ building_id: building.id, position: building.position, distance: Math.round(planar(building.position?.x ?? 0, building.position?.z ?? 0, hq.x ?? 0, hq.z ?? 0)) }))
              .sort((a, b) => a.distance - b.distance)
              .slice(0, 3);
            actions.push({
              objective: objective.id,
              type,
              action: "派队搜刮建筑",
              targets: near,
              note: "用 scavenge_building 派队进入；优先最近的建筑，配合 find_buildings_by_poi 找资源图标",
            });
          } else if (["CollectResource", "ProduceResource"].includes(type)) {
            actions.push({
              objective: objective.id,
              type,
              action: "收集/生产资源",
              targets: idleSites.slice(0, 3).map((site) => ({ building_id: site.building_id, work: site.work, max_workers: site.max_workers })),
              note: "检查库存缺口与空置工地（get_economy / get_worker_balance），给对应生产建筑派工",
            });
          } else if (type === "AssignWorkers") {
            actions.push({
              objective: objective.id,
              type,
              action: "分配工人",
              targets: idleSites.slice(0, 5).map((site) => ({ building_id: site.building_id, work: site.work, max_workers: site.max_workers })),
              note: "用 set_building_workers 调整岗位上限，或在游戏内分配人口",
            });
          } else if (type === "HealGroup") {
            actions.push({
              objective: objective.id,
              type,
              action: "治疗队伍",
              targets: wounded.map((squad) => ({ squad_id: squad.id, minHp: squad.minHp })),
              note: wounded.length ? "把受伤队伍撤回总部用药品治疗" : "目前没有低于 60 血的队伍",
            });
          } else if (["SendToMarker", "SendToMarkers", "CharacterCountInsideEnterableWithMarker"].includes(type)) {
            actions.push({
              objective: objective.id,
              type,
              action: "前往任务标记",
              targets: (mission.markers ?? []).map((marker, index) => ({ index, position: marker, nearestSquad: nearestSquad(marker) })),
              note: "用 move_squad 把队伍移到标记附近（每次 6–100 单位，可多次接力）",
            });
          } else if (["AdaptBuilding", "ConstructBuilding", "CancelAdaptation", "StartPartialAdaptation", "AdaptLivingSpaceForCivilians"].includes(type)) {
            actions.push({
              objective: objective.id,
              type,
              action: "建筑适配/建造",
              note: "需要玩家在游戏内选择建筑并派工；AI 可以读建筑与岗位但不能代替选楼",
            });
          } else if (type === "SurviveNight") {
            actions.push({ objective: objective.id, type, action: "熬过夜晚", detail: { sunsetInHours: sunsetIn }, note: "日落前收队回防、布夜哨" });
          } else {
            actions.push({ objective: objective.id, type, action: "按游戏内提示完成", note: "该目标类型暂无可自动化的下步指令，参考游戏任务面板" });
          }
        }
        plans.push({
          mission_id: mission.id,
          title_key: mission.title_key,
          chapter_id: mission.chapter_id,
          time_to_resolve: mission.time_to_resolve,
          markers: mission.markers,
          actions,
        });
      }
      return { ok: true, time: state.time, sunsetInHours: sunsetIn, squadSummary: squadRows, planCount: plans.length, plans };
    },
  );
}
