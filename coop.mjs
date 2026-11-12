import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { nearbyScavengeQuery, readMapPage } from "./map-query.mjs";

const usage = [
  "coop brief [--near SQUAD]",
  "coop check --squad SQUAD [--session SESSION]",
  "coop scavenge --session SESSION --player PLAYER --squad SQUAD --building BUILDING --notice TEXT",
  "coop return --session SESSION --player PLAYER --squad SQUAD [--stockroom STOCKROOM] --notice TEXT",
];
const essentialResources = new Set(["res_cans", "res_ammo", "res_fuel"]);
const milliseconds = (start) => Math.round(performance.now() - start);
const distance = (a, b) => a && b ? Math.round(Math.hypot(a.x - b.x, a.z - b.z)) : null;
const errorInfo = (error) => ({ code: error.code ?? "coop_error", message: error.message });

function requireCondition(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code });
}

export async function readState(call, session) {
  const state = await call("get_state", {});
  requireCondition(state.ready, "not_ready", "载入存档并进入聚落后重试。");
  requireCondition(!session || state.session_id === session, "session_changed", "游戏会话已变化，请重新确认分工。");
  return state;
}

export async function readWorld(call, state, category) {
  const items = [];
  let offset = 0;
  do {
    const page = await call("get_world_data", { session_id: state.session_id, category, limit: 100, offset });
    items.push(...page.items);
    offset = page.next_offset;
  } while (offset != null);
  return items;
}

export function squadDetails(squad, vehicles) {
  const vehicle = vehicles.find((item) => item.id === (squad.vehicle_id ?? squad.waiting_vehicle_id));
  return {
    id: squad.id, name: squad.name, position: squad.position, destination: squad.destination,
    order: squad.active_order, queued: squad.queued_orders, cargo: squad.cargo,
    hp_min: squad.members.length ? Math.min(...squad.members.map((member) => member.hp ?? 100)) : null,
    ammo_min: squad.members.length ? Math.min(...squad.members.map((member) => member.ammo ?? 0)) : null,
    vehicle: vehicle && {
      id: vehicle.id, type: vehicle.type, driver: vehicle.has_driver,
      fuel_ratio: vehicle.fuel.ratio, slots: vehicle.trunk.occupied_slots,
      capacity: vehicle.trunk.capacity_slots, cargo: vehicle.trunk.cargo,
    },
  };
}

async function brief(call, near) {
  const start = performance.now();
  const state = await readState(call);
  const status = await call("status", {});
  const squads = await readWorld(call, state, "squads");
  const vehicles = await readWorld(call, state, "vehicles");
  const supplies = (await readWorld(call, state, "stockpile")).filter((item) => essentialResources.has(item.resource_id));
  const enemies = [...await readWorld(call, state, "groups"), ...await readWorld(call, state, "virtual_groups")]
    .filter((group) => group.visible && group.position && group.member_count > 0 &&
      ["Infected", "Bandits"].includes(group.faction));
  const threats = enemies.map((group) => ({
    type: group.type, count: group.member_count, position: group.position, destination: group.destination,
    hq_distance: distance(group.position, state.headquarters),
    squad_distances: Object.fromEntries(squads.map((squad) => [squad.id, distance(group.position, squad.position)])),
  })).sort((a, b) => Math.min(a.hq_distance, ...Object.values(a.squad_distances)) -
    Math.min(b.hq_distance, ...Object.values(b.squad_distances))).slice(0, 6);
  let candidates, mapError;
  if (near) {
    const squad = squads.find((item) => item.id === near);
    requireCondition(squad, "unknown_squad", "指定的小队已不存在。");
    const map = squad.position
      ? await readMapPage(call, state.session_id, { ...nearbyScavengeQuery(squad.position), limit: 8 })
      : { items: [] };
    mapError = map.error;
    candidates = map.items?.map((building) => ({
        id: building.id, position: building.position,
        distance: distance(squad.position, building.position),
        hq_distance: distance(state.headquarters, building.position),
      }));
  }
  return {
    ok: true, session: state.session_id, time: state.time, focused: state.focused,
    control_owner: status.control_owner, headquarters: state.headquarters,
    squads: squads.map((squad) => squadDetails(squad, vehicles)), threats, supplies, candidates, map_error: mapError,
    timing_ms: { read: milliseconds(start) },
  };
}

async function check(call, squadId, session) {
  requireCondition(squadId, "invalid_squad", usage[1]);
  const state = await readState(call, session);
  const squad = (await readWorld(call, state, "squads")).find((item) => item.id === squadId);
  requireCondition(squad, "unknown_squad", "指定的小队已不存在。");
  const vehicles = squad.vehicle_id || squad.waiting_vehicle_id ? await readWorld(call, state, "vehicles") : [];
  return { ok: true, session: state.session_id, time: state.time, focused: state.focused, squad: squadDetails(squad, vehicles) };
}

function requireRunning(state) {
  requireCondition(state.focused && !state.time.paused && state.advance?.state !== "running",
    "game_blocked", "请保持游戏在前台并以 1 倍速运行。");
}

async function availableSquad(call, state, player, squadId) {
  const squads = await readWorld(call, state, "squads");
  const squad = squads.find((item) => item.id === squadId);
  requireCondition(squad && squads.some((item) => item.id === player),
    "squad_changed", "玩家队或协作队已变化，请重新确认分工。");
  requireCondition(!squad.active_order && !squad.queued_orders?.length,
    "squad_busy", "小队已有订单，等它完成后再下单。");
  return squad;
}

async function issue(call, action, options) {
  const { session, player, squad: squadId, building, stockroom } = options;
  const notice = options.notice?.trim();
  requireCondition(session && player && squadId && notice && notice.length <= 280 &&
    (action !== "scavenge" || building), "invalid_order", usage[2 + Number(action === "return")]);
  const task = action === "scavenge" ? `搜刮建筑 ${building}` :
    stockroom ? `返回仓库 ${stockroom}` : "返回总部";
  return executeCoopOrder(call, {
    session, player, squadId, task, notice,
    command: action === "scavenge" ? "scavenge_building" : "return_to_stockroom",
    parameters: (current) => action === "scavenge" ? { building_id: building } : {
      ...(stockroom && { stockroom_id: stockroom }),
      ...(current.vehicle_id && { vehicle_id: current.vehicle_id }),
    },
  });
}

export async function executeCoopOrder(call, {
  session, player, squadId, task, notice, command, parameters, validate, signal, heldLease,
  stableRequestId, onSubmit, owner = "Codex", noticeLeadMs = 1000,
}) {
  requireCondition(player !== squadId, "player_squad", "该小队由玩家保留。");
  signal?.throwIfAborted();

  const start = performance.now();
  const initial = await readState(call, session);
  requireRunning(initial);
  const squad = await availableSquad(call, initial, player, squadId);
  const timings = { preflight: milliseconds(start) };
  const lease = heldLease ?? (await call("acquire_control", { owner })).lease;
  const control = { lease, session_id: session };
  const errors = [];
  let pausedByUs = false;
  let requestId, receipt, receiptTime, after;

  try {
    const announcement = performance.now();
    await call("hud_message", { text: `${squad.name || squadId}准备${task}。${notice}`, seconds: 30 });
    if (noticeLeadMs > 0) await sleep(noticeLeadMs, undefined, { signal });
    timings.notice = milliseconds(announcement);
    requireRunning(await readState(call, session));
    const paused = await call("pause", control);
    pausedByUs = paused.time.gameplay_pause;
    requireCondition(paused.session_id === session && pausedByUs && paused.focused &&
      !paused.time.popup_pause && !paused.time.ui_pause, "game_blocked", "游戏状态变了，请重新查看局势。");
    const current = await availableSquad(call, paused, player, squadId);
    requireCondition(squad.vehicle_id === current.vehicle_id && squad.waiting_vehicle_id === current.waiting_vehicle_id,
      "vehicle_changed", "小队车辆已变化，请重新查看局势。");
    await validate?.(paused, current);
    signal?.throwIfAborted();

    const commandArgs = parameters(current);
    requestId = stableRequestId ?? randomUUID();
    onSubmit?.();
    const submission = performance.now();
    receipt = await call(command, {
      ...commandArgs, ...control, request_id: requestId, squad_id: squadId,
    });
    receiptTime = performance.now();
    timings.submit = milliseconds(submission);
  } catch (error) {
    errors.push(errorInfo(error));
  } finally {
    if (pausedByUs) {
      try {
        const state = await readState(call, session);
        if (state.time.gameplay_pause && !state.time.popup_pause && !state.time.ui_pause) {
          const resumed = await call("advance", { ...control, seconds: 1, keep_running: true, allow_background: true });
          requireCondition(!resumed.time.paused, "resume_blocked", "游戏未恢复 1 倍速。");
        }
      } catch (error) {
        errors.push(errorInfo(error));
      }
    }
    try {
      if (!heldLease) await call("release_control", { lease });
    } catch (error) {
      errors.push(errorInfo(error));
    }
  }

  const rereadStart = performance.now();
  try {
    after = await check(call, squadId, session);
  } catch (error) {
    errors.push(errorInfo(error));
  }
  timings.reread = milliseconds(rereadStart);
  if (receiptTime) timings.receipt_to_reread = milliseconds(receiptTime);
  timings.total = milliseconds(start);
  return {
    ok: Boolean(receipt && (receipt.state === "accepted" || receipt.state === undefined) && !errors.length),
    request_id: requestId, receipt, after, errors, timing_ms: timings,
  };
}

export async function runCoop(args, call) {
  try {
    const [command, ...parameters] = args;
    if (!command || command === "--help") return { ok: true, usage };
    const { values } = parseArgs({
      args: parameters,
      options: Object.fromEntries(["near", "squad", "session", "player", "building", "stockroom", "notice"]
        .map((key) => [key, { type: "string" }])),
    });
    switch (command) {
      case "brief": return await brief(call, values.near);
      case "check": return await check(call, values.squad, values.session);
      case "scavenge":
      case "return": return await issue(call, command, values);
      default: return { ok: false, usage };
    }
  } catch (error) {
    return { ok: false, error: errorInfo(error) };
  }
}
