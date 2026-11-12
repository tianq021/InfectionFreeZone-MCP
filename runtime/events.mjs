// Semantic event detection over successive world-state snapshots.
// Pure functions plus a stateful engine that owns dedupe/hysteresis state.
import { isDeepStrictEqual } from "node:util";

export const DEFAULT_EVENT_CONFIG = {
  enemyInfoDistance: 220,
  enemyWarnDistance: 120,
  enemyCriticalDistance: 70,
  squadLowHp: 60,
  squadCriticalHp: 35,
  squadThreatRadius: 45,
  cargoFullRatio: 0.9,
  cargoClearRatio: 0.8,
  stockLow: { res_cans: 8, res_ammo: 10, res_fuel: 3 },
  stuckMs: 60000,
  dedupeWindows: { enemy_approach: 15000, squad_low_hp: 15000, squad_threat: 15000, cargo_full: 30000, low_stock: 30000, mission_updated: 10000 },
};

/** Fields that advance every frame even when nothing meaningful changed. */
export const VOLATILE_TIME_FIELDS = ["hour", "elapsed_game_seconds"];

export const distance = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
}

/** Content hash that ignores clock-only drift, so long-poll waits are meaningful. */
export function meaningfulHash(state) {
  if (!state) return "null";
  const clone = {
    ready: state.ready,
    sessionId: state.sessionId,
    day: state.time?.day,
    sunset: state.time?.sunset,
    paused: state.time?.paused,
    focused: state.focused,
    headquarters: state.headquarters,
    dialogue: state.dialogue ?? null,
    radioPaused: state.radioPaused,
    squads: state.squads ?? [],
    vehicles: state.vehicles ?? [],
    groups: state.groups ?? [],
    virtualGroups: state.virtualGroups ?? [],
    events: state.events ?? [],
    stockpile: state.stockpile ?? [],
    stockrooms: state.stockrooms ?? [],
    buildings: state.buildings ?? [],
    worksites: state.worksites ?? [],
  };
  return stableStringify(clone);
}

/** Deep change list limited to a few levels so deltas stay small. */
export function deepChanges(prev, next, { maxDepth = 3, prefix = "", out = [] } = {}) {
  if (out.length > 200) return out;
  if (prev === next) return out;
  const bothObjects = prev && next && typeof prev === "object" && typeof next === "object";
  if (!bothObjects || maxDepth <= 0 || Array.isArray(prev) !== Array.isArray(next)) {
    if (bothObjects && isDeepStrictEqual(prev, next)) return out;
    out.push({ path: prefix || "$", value: next });
    return out;
  }
  if (Array.isArray(prev)) {
    if (prev.length !== next.length) out.push({ path: prefix, value: next });
    else for (let i = 0; i < next.length; i++) deepChanges(prev[i], next[i], { maxDepth: maxDepth - 1, prefix: `${prefix}[${i}]`, out });
    return out;
  }
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in next)) { out.push({ path, value: null, removed: true }); continue; }
    if (!(key in prev)) { out.push({ path, value: next[key] }); continue; }
    deepChanges(prev[key], next[key], { maxDepth: maxDepth - 1, prefix: path, out });
  }
  return out;
}

/** Keyed collection diff: added / updated (with field changes) / removed ids. */
export function diffRecords(prevRows = [], nextRows = [], { key = "id", maxDepth = 3 } = {}) {
  const prevMap = new Map((prevRows ?? []).map((row) => [String(row[key]), row]));
  const nextMap = new Map((nextRows ?? []).map((row) => [String(row[key]), row]));
  const added = [];
  const updated = [];
  const removed = [];
  for (const [id, row] of nextMap) {
    const before = prevMap.get(id);
    if (!before) added.push(row);
    else {
      const changes = deepChanges(before, row, { maxDepth });
      if (changes.length) updated.push({ id, changes });
    }
  }
  for (const id of prevMap.keys()) if (!nextMap.has(id)) removed.push(id);
  return { added, updated, removed };
}

const CATEGORY_KEYS = {
  squads: "id", vehicles: "id", groups: "id", virtualGroups: "id",
  events: "id", stockpile: "resource_id", stockrooms: "id", buildings: "id", worksites: "building_id",
};

/** Full state delta for AI consumption (only changed records). */
export function diffState(prev, next) {
  if (!prev || !next) return null;
  const delta = { fromVersion: prev.version, toVersion: next.version };
  if (!isDeepStrictEqual(prev.dialogue ?? null, next.dialogue ?? null)) delta.dialogue = next.dialogue ?? null;
  for (const [category, key] of Object.entries(CATEGORY_KEYS)) {
    const before = prev[category] ?? [];
    const after = next[category] ?? [];
    const categoryDelta = diffRecords(before, after, { key });
    if (categoryDelta.added.length || categoryDelta.updated.length || categoryDelta.removed.length) delta[category] = categoryDelta;
  }
  const headerChanges = deepChanges(
    { ready: prev.ready, paused: prev.time?.paused, focused: prev.focused, sessionId: prev.sessionId,
      day: prev.time?.day, sunset: prev.time?.sunset, headquarters: prev.headquarters, radioPaused: prev.radioPaused },
    { ready: next.ready, paused: next.time?.paused, focused: next.focused, sessionId: next.sessionId,
      day: next.time?.day, sunset: next.time?.sunset, headquarters: next.headquarters, radioPaused: next.radioPaused },
    { maxDepth: 2 },
  );
  if (headerChanges.length) delta.header = headerChanges;
  return delta;
}

export class EventEngine {
  constructor({ config = {}, now = () => Date.now() } = {}) {
    this.config = { ...DEFAULT_EVENT_CONFIG, ...config, stockLow: { ...DEFAULT_EVENT_CONFIG.stockLow, ...(config.stockLow ?? {}) }, dedupeWindows: { ...DEFAULT_EVENT_CONFIG.dedupeWindows, ...(config.dedupeWindows ?? {}) } };
    this.now = now;
    this.reset();
  }

  reset() {
    this.lastHpBucket = new Map();
    this.lastOrder = new Map();
    this.lastPosition = new Map();
    this.stuckSince = new Map();
    this.lastCargoFull = new Map();
    this.lowStock = new Map();
    this.lastMissionSig = null;
    this.lastDay = null;
    this.lastPaused = null;
    this.lastFocused = null;
    this.lastEmitted = new Map();
    this.lastEnemyDistance = new Map();
  }

  dedupe(event) {
    const window = this.config.dedupeWindows[event.type] ?? 10000;
    const last = this.lastEmitted.get(event.dedupeKey);
    if (last != null && event.at - last < window) return false;
    this.lastEmitted.set(event.dedupeKey, event.at);
    return true;
  }

  /** @returns {Array<{type,severity,dedupeKey,data}>} only newly meaningful events */
  detect(prev, next) {
    const at = next.at ?? this.now();
    const results = [];
    const emit = (type, severity, dedupeKey, data) => {
      const event = { type, severity, dedupeKey, data, at };
      if (this.dedupe(event)) results.push(event);
    };
    this.detectDayPhase(prev, next, emit);
    this.detectPauseFocus(prev, next, emit);
    this.detectEnemies(prev, next, emit, at);
    this.detectSquads(prev, next, emit, at);
    this.detectCargo(prev, next, emit);
    this.detectStock(prev, next, emit);
    this.detectMissions(prev, next, emit);
    return results;
  }

  detectDayPhase(prev, next, emit) {
    const day = next.time?.day;
    const hour = next.time?.hour ?? 0;
    const sunset = next.time?.sunset ?? 18;
    if (this.lastDay == null) this.lastDay = day;
    if (prev && this.lastDay != null && day != null && day !== this.lastDay) emit("new_day", "info", `day:${day}`, { day });
    if (prev) {
      const beforeHour = prev.time?.hour ?? 0;
      if (beforeHour < sunset && hour >= sunset) emit("nightfall", "info", `night:${day}`, { day, hour });
    }
    if (day != null) this.lastDay = day;
  }

  detectPauseFocus(prev, next, emit) {
    const paused = Boolean(next.time?.paused);
    if (this.lastPaused != null && paused !== this.lastPaused) emit("game_paused_changed", "info", `paused:${paused}`, { paused });
    this.lastPaused = paused;
    if (this.lastFocused != null && Boolean(next.focused) !== this.lastFocused) emit("focus_changed", "info", `focus:${Boolean(next.focused)}`, { focused: Boolean(next.focused) });
    this.lastFocused = Boolean(next.focused);
  }

  detectEnemies(prev, next, emit) {
    const hq = next.headquarters;
    for (const group of next.groups ?? []) {
      if (!group.visible || !group.position || !(group.member_count > 0)) continue;
      if (!(group.hostile_to_player ?? ["Infected", "Bandits"].includes(group.faction))) continue;
      const d = distance(group.position, hq);
      const before = this.lastEnemyDistance.get(String(group.id));
      this.lastEnemyDistance.set(String(group.id), d);
      const level = d <= this.config.enemyCriticalDistance ? "critical" : d <= this.config.enemyWarnDistance ? "warn" : d <= this.config.enemyInfoDistance ? "info" : null;
      if (!level) continue;
      const beforeLevel = before == null ? null
        : before <= this.config.enemyCriticalDistance ? "critical" : before <= this.config.enemyWarnDistance ? "warn" : before <= this.config.enemyInfoDistance ? "info" : null;
      const worsened = beforeLevel == null || (level === "critical" && beforeLevel !== "critical") || (level === "warn" && beforeLevel === "info");
      if (!worsened) continue;
      emit("enemy_approach", level === "critical" ? "critical" : level, `enemy_approach:${group.id}:${level}`, {
        groupId: String(group.id), type: group.type, count: group.member_count, hqDistance: d,
        position: group.position, destination: group.destination ?? null, previousDistance: before ?? null,
      });
    }
    // forget stale groups so a later re-approach is reported again
    const alive = new Set((next.groups ?? []).map((group) => String(group.id)));
    for (const id of this.lastEnemyDistance.keys()) if (!alive.has(id)) this.lastEnemyDistance.delete(id);
  }

  detectSquads(prev, next, emit, at) {
    const hostiles = (next.groups ?? []).filter((group) => group.visible && group.position &&
      (group.hostile_to_player ?? ["Infected", "Bandits"].includes(group.faction)));
    const hq = next.headquarters;
    for (const squad of next.squads ?? []) {
      const squadId = String(squad.id);
      for (const member of squad.members ?? []) {
        const hp = member.hp ?? 100;
        const bucket = hp < this.config.squadCriticalHp ? "critical" : hp < this.config.squadLowHp ? "low" : "normal";
        const before = this.lastHpBucket.get(`${squadId}:${member.id}`) ?? "normal";
        if (bucket !== "normal" && bucket !== before && (before === "normal" || bucket === "critical")) {
          emit("squad_low_hp", bucket === "critical" ? "critical" : "warn", `hp:${squadId}:${member.id}:${bucket}`, {
            squadId, memberId: String(member.id), hp, bucket,
          });
        }
        this.lastHpBucket.set(`${squadId}:${member.id}`, bucket);
      }
      const nearest = hostiles
        .map((group) => ({ group, d: distance(group.position, squad.position) }))
        .sort((a, b) => a.d - b.d)[0];
      if (nearest && nearest.d <= this.config.squadThreatRadius) {
        emit("squad_threat", "critical", `threat:${squadId}:${nearest.group.id}`, {
          squadId, groupId: String(nearest.group.id), type: nearest.group.type,
          count: nearest.group.member_count, distance: nearest.d,
        });
      }
      const order = squad.active_order ?? null;
      const beforeOrder = this.lastOrder.get(squadId) ?? null;
      if (prev && beforeOrder && !order) emit("order_completed", "info", `order_done:${squadId}:${beforeOrder}`, { squadId, previousOrder: beforeOrder });
      else if (prev && order && beforeOrder && order !== beforeOrder) emit("order_changed", "info", `order_changed:${squadId}:${order}`, { squadId, from: beforeOrder, to: order });
      this.lastOrder.set(squadId, order);
      // stuck detection
      const pos = squad.position;
      const last = this.lastPosition.get(squadId);
      if (order && pos && last && last.x === pos.x && last.z === pos.z) {
        const since = this.stuckSince.get(squadId) ?? at;
        this.stuckSince.set(squadId, since);
        if (at - since >= this.config.stuckMs) emit("squad_stuck", "warn", `stuck:${squadId}:${order}`, { squadId, order, ms: at - since });
      } else {
        this.stuckSince.delete(squadId);
        if (pos) this.lastPosition.set(squadId, { x: pos.x, z: pos.z });
      }
      if (pos) this.lastPosition.set(squadId, { x: pos.x, z: pos.z });
      void hq;
    }
  }

  detectCargo(prev, next, emit) {
    for (const vehicle of next.vehicles ?? []) {
      const ratio = vehicle.trunk?.load_ratio ?? (vehicle.trunk?.occupied_slots != null && vehicle.trunk?.capacity_slots
        ? vehicle.trunk.occupied_slots / vehicle.trunk.capacity_slots : null);
      if (ratio == null) continue;
      const wasFull = this.lastCargoFull.get(String(vehicle.id)) ?? false;
      if (ratio >= this.config.cargoFullRatio && !wasFull) {
        emit("cargo_full", "info", `cargo:${vehicle.id}`, { vehicleId: String(vehicle.id), ratio: Math.round(ratio * 100) / 100 });
        this.lastCargoFull.set(String(vehicle.id), true);
      } else if (ratio < this.config.cargoClearRatio) this.lastCargoFull.set(String(vehicle.id), false);
    }
  }

  detectStock(prev, next, emit) {
    for (const item of next.stockpile ?? []) {
      if (item.storage && item.storage !== "physical") continue;
      const threshold = this.config.stockLow[item.resource_id];
      if (threshold == null) continue;
      const available = item.available ?? 0;
      const wasLow = this.lowStock.get(item.resource_id) ?? false;
      if (available < threshold && !wasLow) {
        emit("low_stock", available <= threshold / 2 ? "warn" : "info", `stock:${item.resource_id}`, { resourceId: item.resource_id, available, threshold });
        this.lowStock.set(item.resource_id, true);
      } else if (available > threshold * 1.2) this.lowStock.set(item.resource_id, false);
    }
  }

  detectMissions(prev, next, emit) {
    const missions = next.events ?? [];
    const signature = stableStringify(missions.map((mission) => [mission.id, (mission.objectives ?? []).map((objective) => Boolean(objective.completed))]));
    if (this.lastMissionSig != null && this.lastMissionSig !== signature) {
      const changed = missions.filter((mission) => (mission.objectives ?? []).some((objective) => objective.completed)).map((mission) => mission.id);
      emit("mission_updated", "info", `missions:${signature.length}`, { missions: changed.slice(0, 8) });
    }
    this.lastMissionSig = signature;
  }
}

export function createEventEngine(options) {
  return new EventEngine(options);
}
