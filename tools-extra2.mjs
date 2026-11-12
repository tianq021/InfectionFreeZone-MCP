// 第二批复合/本地工具：地形报告、路线规划、搜刮目标与计划、每日报告、人口/武器/岗位分析、变更对比、找车。
// 约定同 tools-extra.mjs：组合现有桥接调用，不需要插件改动。

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWeather } from "./weather.mjs";
import { readAll, summarizeThreats, summarizeEconomy, summarizeSquads, RESOURCE_THRESHOLDS } from "./tools-extra.mjs";
import { newestSaveInfo } from "./tools-extra.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheFile = path.join(here, ".local", "cache", "get_changes.json");

const HQ_FALLBACK = { x: 1430, z: 1146 };

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function planar(ax, az, bx, bz) {
  return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
}

async function sessionState(request) {
  const state = await request("get_state", {});
  if (!state || state.ok !== true) {
    throw Object.assign(new Error(state?.message ?? "get_state failed"), { code: state?.code ?? "state_unavailable" });
  }
  return state;
}

function hqOf(state) {
  return state.headquarters ? { x: state.headquarters.x, z: state.headquarters.z } : HQ_FALLBACK;
}

// ---------------------------------------------------------------------------
// 地形与路线
// ---------------------------------------------------------------------------

const PASSABLE_COST = { G: 1, R: 0.7, b: 1, B: 1.2, D: 6 };

function gridIndex(terrain) {
  const { cols, rows, bounds, step } = terrain;
  const blocked = new Set();
  const cost = new Float32Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    const line = terrain.rows_text[row] ?? "";
    for (let col = 0; col < cols; col++) {
      const kind = line[col] ?? "?";
      const index = row * cols + col;
      const value = PASSABLE_COST[kind];
      if (value === undefined) {
        blocked.add(index);
        cost[index] = Number.POSITIVE_INFINITY;
      } else {
        cost[index] = value;
      }
    }
  }
  const toCell = (x, z) => ({
    col: Math.round((x - bounds.min_x) / step),
    row: Math.round((z - bounds.min_z) / step),
  });
  const toWorld = (col, row) => ({
    x: round(bounds.min_x + col * step),
    z: round(bounds.min_z + row * step),
  });
  return { cols, rows, step, bounds, blocked, cost, toCell, toWorld };
}

function nearestPassable(grid, start) {
  const clampCell = (value, max) => Math.max(0, Math.min(max - 1, value));
  const base = { col: clampCell(start.col, grid.cols), row: clampCell(start.row, grid.rows) };
  if (!grid.blocked.has(base.row * grid.cols + base.col)) return base;
  for (let radius = 1; radius <= 6; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const row = base.row + dr;
        const col = base.col + dc;
        if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) continue;
        if (!grid.blocked.has(row * grid.cols + col)) return { row, col };
      }
    }
  }
  return null;
}

/** 在栅格上跑 A*（8 邻域），返回路径与统计。 */
export function planPathOnGrid(terrain, from, to) {
  const grid = gridIndex(terrain);
  const start = nearestPassable(grid, grid.toCell(from.x, from.z));
  const goal = nearestPassable(grid, grid.toCell(to.x, to.z));
  if (!start || !goal) return { ok: false, code: "no_path", message: "起终点附近没有可通行格子" };

  const { cols, rows } = grid;
  const size = cols * rows;
  const gScore = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);
  const startIndex = start.row * cols + start.col;
  const goalIndex = goal.row * cols + goal.col;
  gScore[startIndex] = 0;

  const heuristic = (index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    return Math.hypot(col - goal.col, row - goal.row);
  };
  const open = [startIndex];
  const fScore = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  fScore[startIndex] = heuristic(startIndex);

  while (open.length) {
    let bestPosition = 0;
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestPosition]]) bestPosition = i;
    }
    const current = open.splice(bestPosition, 1)[0];
    if (current === goalIndex) break;
    if (closed[current]) continue;
    closed[current] = 1;
    const row = Math.floor(current / cols);
    const col = current % cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const next = nr * cols + nc;
        if (grid.blocked.has(next)) continue;
        const stepCost = grid.cost[next] * (dr !== 0 && dc !== 0 ? 1.414 : 1);
        const tentative = gScore[current] + stepCost;
        if (tentative >= gScore[next]) continue;
        cameFrom[next] = current;
        gScore[next] = tentative;
        fScore[next] = tentative + heuristic(next);
        if (!closed[next] && !open.includes(next)) open.push(next);
      }
    }
  }

  if (!Number.isFinite(gScore[goalIndex])) return { ok: false, code: "no_path", message: "栅格上找不到可行路径" };
  const path = [];
  for (let index = goalIndex; index !== -1; index = cameFrom[index]) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    path.push({ ...grid.toWorld(col, row), kind: terrain.rows_text[row]?.[col] ?? "?" });
    if (index === startIndex) break;
  }
  path.reverse();
  return { ok: true, path, grid };
}

function summarizePath(path, waypointSpacing = 150) {
  let distance = 0;
  let bridges = 0;
  const waypoints = [];
  let sinceWaypoint = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const stepDistance = planar(path[i - 1].x, path[i - 1].z, path[i].x, path[i].z);
      distance += stepDistance;
      sinceWaypoint += stepDistance;
    }
    if (path[i].kind === "b") bridges++;
    if (i === 0 || sinceWaypoint >= waypointSpacing || i === path.length - 1) {
      waypoints.push({ x: path[i].x, z: path[i].z, kind: path[i].kind });
      sinceWaypoint = 0;
    }
  }
  return { distance: round(distance), bridges, waypoints };
}

// ---------------------------------------------------------------------------
// 建筑与搜刮
// ---------------------------------------------------------------------------

function clusterBuildings(buildings, cellSize = 300) {
  const clusters = new Map();
  for (const building of buildings) {
    const key = `${Math.floor(building.position.x / cellSize)},${Math.floor(building.position.z / cellSize)}`;
    if (!clusters.has(key)) clusters.set(key, { buildings: [], x: building.position.x, z: building.position.z });
    const cluster = clusters.get(key);
    cluster.buildings.push(building);
    cluster.x = (cluster.x * (cluster.buildings.length - 1) + building.position.x) / cluster.buildings.length;
    cluster.z = (cluster.z * (cluster.buildings.length - 1) + building.position.z) / cluster.buildings.length;
  }
  return [...clusters.values()];
}

async function loadScavengeTargets(request, sessionId) {
  const reply = await request("get_map_buildings", { session_id: sessionId, scope: "full", limit: 100 });
  if (!reply || reply.ok !== true) throw new Error(reply?.message ?? "get_map_buildings failed");
  let items = reply.items ?? [];
  let offset = reply.next_offset;
  while (offset != null) {
    const page = await request("get_map_buildings", { session_id: sessionId, scope: "full", offset, limit: 100 });
    if (!page || page.ok !== true) break;
    items = items.concat(page.items ?? []);
    offset = page.next_offset;
  }
  return items.filter((building) => building.can_scavenge && !building.scavenged && !building.stockroom);
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export function registerMoreTools({ registerLocal, request, readOnly = false }) {
  const loadCache = () => {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      return { stockpile: {}, squads: {}, threatCount: null, at: null };
    }
  };
  const saveCache = (value) => {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(value), "utf8");
    } catch {
      // 缓存写失败不影响主流程
    }
  };

  registerLocal(
    "get_terrain_report",
    "One-call terrain analysis: water/road/wall/building shares, bridge candidates with coordinates, elevation range and the clearest corridor rows. Uses get_terrain_grid internally.",
    {
      step: z.number().min(10).max(300).optional().describe("Grid step (default 75)"),
      include_ascii: z.boolean().optional().describe("Include the character map (default false)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const step = args.step ?? 75;
      const reply = await request("get_terrain_grid", { session_id: state.session_id, step, max_cells: 20000, include_heights: true });
      if (!reply || reply.ok !== true) throw new Error(reply?.message ?? "get_terrain_grid failed");
      const total = reply.cells;
      const share = (value) => round((value / total) * 100, 1);
      const counts = reply.counts ?? {};
      const rows = reply.rows_text ?? [];
      const corridors = [...rows.entries()]
        .map(([index, line]) => ({ row: index, z: round(reply.bounds.min_z + index * step), passable: [...line].filter((ch) => "GRb".includes(ch)).length }))
        .sort((a, b) => b.passable - a.passable)
        .slice(0, 5);
      return {
        ok: true,
        time: state.time,
        step,
        grid: { cols: reply.cols, rows: reply.rows, bounds: reply.bounds },
        shares: {
          water: share(counts.water ?? 0),
          road: share(counts.road ?? 0),
          ground: share(counts.ground ?? 0),
          buildingFloors: share(counts.building ?? 0),
          unwalkable: share((counts.unwalkable ?? 0) + (counts.no_node ?? 0) + (counts.detached ?? 0)),
        },
        bridges: reply.bridges ?? [],
        elevation: reply.elevation ?? null,
        bestCorridorRows: corridors,
        ascii: args.include_ascii ? rows : null,
      };
    },
  );

  registerLocal(
    "plan_route",
    "Plan a walkable route between two world points on the game's pathfinding graph (roads cost less, water/void blocked). Returns distance, waypoints and how many bridge cells the route uses.",
    {
      from_x: z.number().finite(),
      from_z: z.number().finite(),
      to_x: z.number().finite(),
      to_z: z.number().finite(),
      step: z.number().min(10).max(100).optional().describe("Planning grid step (default 25)"),
      waypoint_spacing: z.number().min(50).max(500).optional().describe("Distance between returned waypoints (default 150)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const step = args.step ?? 25;
      const margin = Math.max(300, step * 12);
      const reply = await request("get_terrain_grid", {
        session_id: state.session_id,
        step,
        min_x: Math.min(args.from_x, args.to_x) - margin,
        min_z: Math.min(args.from_z, args.to_z) - margin,
        max_x: Math.max(args.from_x, args.to_x) + margin,
        max_z: Math.max(args.from_z, args.to_z) + margin,
        max_cells: 40000,
      });
      if (!reply || reply.ok !== true) throw new Error(reply?.message ?? "get_terrain_grid failed");
      const planned = planPathOnGrid(reply, { x: args.from_x, z: args.from_z }, { x: args.to_x, z: args.to_z });
      if (!planned.ok) return planned;
      const summary = summarizePath(planned.path, args.waypoint_spacing ?? 150);
      return {
        ok: true,
        step,
        from: { x: args.from_x, z: args.from_z },
        to: { x: args.to_x, z: args.to_z },
        ...summary,
      };
    },
  );

  registerLocal(
    "get_loot_targets",
    "Rank un-scavenged buildings for the AI squads: nearest targets, per-squad distances and building clusters (dense areas give more loot per trip).",
    {
      squad_id: z.string().min(1).max(64).optional().describe("Limit ranking to one squad"),
      radius: z.number().min(100).max(3000).optional().describe("Max distance from HQ (default 1200)"),
      limit: z.number().int().min(1).max(40).optional().describe("Max rows (default 12)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, vehicles, targets] = await Promise.all([
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, "vehicles"),
        loadScavengeTargets(request, sessionId),
      ]);
      const hq = hqOf(state);
      const squadRows = summarizeSquads(squads, vehicles);
      const radius = args.radius ?? 1200;
      const filtered = targets
        .map((building) => ({ id: String(building.id), x: building.position.x, z: building.position.z, distance: round(planar(building.position.x, building.position.z, hq.x, hq.z)) }))
        .filter((building) => building.distance <= radius);
      const clusters = clusterBuildings(filtered.map((b) => ({ position: { x: b.x, z: b.z } })))
        .map((cluster) => {
          const members = filtered.filter((b) => planar(b.x, b.z, cluster.x, cluster.z) <= 300);
          return {
            center: { x: round(cluster.x), z: round(cluster.z) },
            count: members.length,
            nearestId: members.sort((a, b) => a.distance - b.distance)[0]?.id ?? null,
            distanceToHq: round(planar(cluster.x, cluster.z, hq.x, hq.z)),
          };
        })
        .filter((cluster) => cluster.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
      const perSquad = squadRows
        .filter((squad) => !args.squad_id || squad.id === args.squad_id)
        .map((squad) => ({
          squadId: squad.id,
          name: squad.name,
          position: squad.position,
          nearest: filtered
            .map((building) => ({ ...building, distance: round(planar(building.x, building.z, squad.position.x, squad.position.z)) }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 5),
        }));
      return {
        ok: true,
        time: state.time,
        totalTargets: filtered.length,
        clusters,
        perSquad,
        top: filtered.sort((a, b) => a.distance - b.distance).slice(0, args.limit ?? 12),
      };
    },
  );

  registerLocal(
    "get_scavenge_plan",
    "Greedy scavenging plan: assigns each squad its own nearest cluster and returns concrete building_id sequences that can be executed with scavenge_building.",
    {
      squad_ids: z.array(z.string().min(1).max(64)).max(6).optional().describe("Squads to plan for (default: first three AI squads)"),
      per_squad: z.number().int().min(1).max(6).optional().describe("Targets per squad (default 3)"),
      radius: z.number().min(100).max(3000).optional().describe("Search radius from HQ (default 1500)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, vehicles, targets] = await Promise.all([
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, "vehicles"),
        loadScavengeTargets(request, sessionId),
      ]);
      const squadRows = summarizeSquads(squads, vehicles);
      const candidates = squadRows.filter((squad) => (args.squad_ids ? args.squad_ids.includes(squad.id) : true));
      const radius = args.radius ?? 1500;
      const pool = targets
        .map((building) => ({ id: String(building.id), x: building.position.x, z: building.position.z }))
        .filter((building) => {
          const hq = hqOf(state);
          return planar(building.x, building.z, hq.x, hq.z) <= radius;
        });
      const perSquad = args.per_squad ?? 3;
      const taken = new Set();
      const plan = candidates.map((squad) => {
        const route = [];
        let cursor = { x: squad.position.x, z: squad.position.z };
        for (let i = 0; i < perSquad; i++) {
          const next = pool
            .filter((building) => !taken.has(building.id))
            .map((building) => ({ ...building, distance: planar(building.x, building.z, cursor.x, cursor.z) }))
            .sort((a, b) => a.distance - b.distance)[0];
          if (!next) break;
          taken.add(next.id);
          route.push({ building_id: next.id, x: round(next.x), z: round(next.z), leg_distance: round(next.distance) });
          cursor = next;
        }
        return {
          squad_id: squad.id,
          name: squad.name,
          vehicle: squad.vehicleId,
          stops: route,
          plan_distance: round(route.reduce((sum, stop) => sum + stop.leg_distance, 0)),
        };
      });
      return { ok: true, time: state.time, squadCount: plan.length, plan };
    },
  );

  registerLocal(
    "get_daily_report",
    "Concise situation report combining time, weather/moon, economy shortfalls, hostile summary, mission progress and heuristic recommendations.",
    {},
    async () => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, vehicles, stockpile, worksites, groups, events] = await Promise.all([
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, "vehicles"),
        readAll(request, sessionId, "stockpile"),
        readAll(request, sessionId, "worksites"),
        readAll(request, sessionId, "groups"),
        readAll(request, sessionId, "events"),
      ]);
      const hq = hqOf(state);
      const economy = summarizeEconomy(stockpile, worksites);
      const threats = summarizeThreats(groups, { hq, squads, maxDistance: 1200 });
      const missions = events
        .filter((entry) => entry.kind === "mission")
        .map((mission) => ({
          id: mission.id,
          done: (mission.objectives ?? []).every((objective) => objective.completed),
          objectives: (mission.objectives ?? []).map((objective) => ({ type: objective.type, completed: Boolean(objective.completed) })),
        }));
      let moon = null;
      try {
        const weather = getWeather();
        moon = {
          fullMoon: weather?.current?.fullMoon ?? null,
          temperature: weather?.current?.temperature ?? null,
          clouds: weather?.current?.clouds ?? null,
          nextFullMoon: weather?.nextFullMoon ?? null,
        };
      } catch {
        moon = null;
      }
      return {
        ok: true,
        time: state.time,
        hq,
        squads: summarizeSquads(squads, vehicles),
        shortfalls: economy.shortfalls,
        idleSites: economy.idleSiteCount,
        idleCapacity: economy.idleCapacity,
        threats: { count: threats.count, closing: threats.closingCount, nearest: threats.nearest.slice(0, 5) },
        missions,
        weather: moon,
      };
    },
  );

  registerLocal(
    "get_colonists_report",
    "Population overview: totals, children, job distribution, armed/unarmed adults, wounded count and the workers assigned to each job.",
    {},
    async () => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const citizens = await readAll(request, sessionId, "citizens");
      const jobs = new Map();
      let children = 0;
      let armed = 0;
      let wounded = 0;
      let adults = 0;
      for (const citizen of citizens) {
        if (citizen.child) children++;
        else adults++;
        if (!citizen.child && citizen.weapon_id && !String(citizen.weapon_id).includes("melee")) armed++;
        if ((citizen.hp ?? 100) < (citizen.max_hp ?? 100) - 0.5) wounded++;
        const job = citizen.job ?? "idle";
        jobs.set(job, (jobs.get(job) ?? 0) + 1);
      }
      return {
        ok: true,
        time: state.time,
        total: citizens.length,
        adults,
        children,
        armed,
        unarmedAdults: adults - armed,
        wounded,
        jobs: [...jobs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([job, count]) => ({ job, count })),
      };
    },
  );

  registerLocal(
    "get_weapons_report",
    "Weapon and ammunition overview: weapon types available, magazine sizes, per-squad composition and members without firearms.",
    {},
    async () => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [weapons, squads] = await Promise.all([readAll(request, sessionId, "weapons"), readAll(request, sessionId, "squads")]);
      const composition = squads.map((squad) => ({
        squadId: squad.id,
        name: squad.name,
        members: (squad.members ?? []).map((member) => ({ id: member.id, weapon: member.weapon_id, ammo: member.ammo })),
        firearms: (squad.members ?? []).filter((member) => member.weapon_id && !String(member.weapon_id).includes("melee") && !String(member.weapon_id).includes("animal")).length,
      }));
      return {
        ok: true,
        time: state.time,
        weaponTypes: weapons.map((weapon) => ({ id: String(weapon.id), melee: weapon.melee, ammoId: weapon.ammo_id, magazine: weapon.magazine_capacity })),
        composition,
      };
    },
  );

  registerLocal(
    "get_worker_balance",
    "Compare idle construction jobs with the current job distribution and suggest which sites to staff first.",
    {},
    async () => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [worksites, citizens] = await Promise.all([readAll(request, sessionId, "worksites"), readAll(request, sessionId, "citizens")]);
      const economy = summarizeEconomy([], worksites);
      const jobCounts = new Map();
      for (const citizen of citizens) {
        if (citizen.child) continue;
        const job = citizen.job ?? "idle";
        jobCounts.set(job, (jobCounts.get(job) ?? 0) + 1);
      }
      return {
        ok: true,
        time: state.time,
        idleSites: economy.idleSites,
        idleCapacity: economy.idleCapacity,
        activeSites: economy.activeSites,
        jobCounts: [...jobCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([job, count]) => ({ job, count })),
        suggestions: economy.idleSites.slice(0, 5).map((site) => ({
          building_id: site.buildingId,
          work: site.work,
          set_max_workers: site.maxWorkers,
        })),
      };
    },
  );

  registerLocal(
    "get_changes",
    "Diff since the previous call in this MCP process: stockpile deltas, squad health changes and hostile count change. Call repeatedly to watch the settlement.",
    {},
    async () => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [stockpile, squads, vehicles, groups] = await Promise.all([
        readAll(request, sessionId, "stockpile"),
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, "vehicles"),
        readAll(request, sessionId, "groups"),
      ]);
      const hq = hqOf(state);
      const previous = loadCache();
      const stockpileNow = {};
      for (const entry of stockpile) {
        if (entry.storage !== "physical") continue;
        stockpileNow[entry.resource_id] = round(entry.quantity, 2);
      }
      const squadNow = {};
      for (const squad of squads) {
        squadNow[squad.id] = {
          minHp: Math.min(...(squad.members ?? []).map((member) => member.hp ?? 100)),
          order: squad.active_order ?? null,
        };
      }
      const threatNow = summarizeThreats(groups, { hq, squads, maxDistance: 2000 }).count;
      const result = {
        ok: true,
        time: state.time,
        baseline: previous.at === null,
        stockpileDelta: [],
        squadChanges: [],
        threatCount: threatNow,
        threatDelta: previous.threatCount === null ? 0 : threatNow - previous.threatCount,
        squads: summarizeSquads(squads, vehicles),
      };
      for (const [resourceId, quantity] of Object.entries(stockpileNow)) {
        const before = previous.stockpile?.[resourceId];
        if (before === undefined) continue;
        const delta = round(quantity - before, 2);
        if (Math.abs(delta) >= 0.1) result.stockpileDelta.push({ resourceId, before, now: quantity, delta });
      }
      for (const [squadId, current] of Object.entries(squadNow)) {
        const before = previous.squads?.[squadId];
        if (!before) continue;
        if (before.minHp !== current.minHp || before.order !== current.order) {
          result.squadChanges.push({ squadId, hpBefore: before.minHp, hpNow: current.minHp, orderBefore: before.order, orderNow: current.order });
        }
      }
      saveCache({ stockpile: stockpileNow, squads: squadNow, threatCount: threatNow, at: Date.now() });
      return result;
    },
  );

  registerLocal(
    "get_vehicle_hunt",
    "List vehicles with ownership, cargo/fuel and the nearest squad, plus unowned vehicles suitable for early-game capture.",
    {
      radius: z.number().min(100).max(4000).optional().describe("Radius from HQ for unowned vehicles (default 2000)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [vehicles, squads] = await Promise.all([readAll(request, sessionId, "vehicles"), readAll(request, sessionId, "squads")]);
      const hq = hqOf(state);
      const rows = vehicles.map((vehicle) => {
        const nearestSquad = squads
          .map((squad) => ({ squadId: squad.id, distance: round(planar(vehicle.position.x, vehicle.position.z, squad.position.x, squad.position.z)) }))
          .sort((a, b) => a.distance - b.distance)[0] ?? null;
        return {
          id: vehicle.id,
          type: vehicle.type,
          owner: vehicle.owner_group_id ?? null,
          fuel: vehicle.fuel?.ratio ?? null,
          load: vehicle.trunk?.load_ratio ?? null,
          position: { x: round(vehicle.position.x), z: round(vehicle.position.z) },
          distanceToHq: round(planar(vehicle.position.x, vehicle.position.z, hq.x, hq.z)),
          nearestSquad,
        };
      });
      const radius = args.radius ?? 2000;
      return {
        ok: true,
        time: state.time,
        vehicles: rows,
        unowned: rows.filter((row) => !row.owner && row.distanceToHq <= radius).sort((a, b) => a.distanceToHq - b.distanceToHq),
      };
    },
  );
}
