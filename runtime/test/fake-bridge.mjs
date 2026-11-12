// Fake bridge that mimics the plugin's request/response surface for state-service tests.
// It is deliberately clock-drifting (game time advances on every get_state) so tests can
// prove the service does not treat clock-only changes as state changes.
import { createWorld, TEST_SESSION } from "./fixtures.mjs";

const CATEGORY_FIELD = {
  squads: "squads", vehicles: "vehicles", groups: "groups", virtual_groups: "virtualGroups",
  stockpile: "stockpile", events: "events", stockrooms: "stockrooms", buildings: "buildings",
  worksites: "worksites", weapons: "weapons",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeBridge {
  constructor({ sessionId = TEST_SESSION, buildingCount = 250, latencyMs = 0 } = {}) {
    const fixture = createWorld({ sessionId, buildingCount });
    this.sessionId = sessionId;
    this.baseState = fixture.state;
    this.world = fixture.world;
    this.online = true;
    this.latencyMs = latencyMs;
    this.calls = [];
    this.failures = 0;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.clockHour = this.baseState.time.hour;
  }

  async call(method, args = {}) {
    this.calls.push({ method, args });
    if (!this.online) {
      this.failures += 1;
      throw Object.assign(new Error("bridge offline"), { code: "bridge_offline" });
    }
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.latencyMs) await sleep(this.latencyMs);
      switch (method) {
        case "status":
          return this.status();
        case "get_state":
          return this.getState();
        case "get_world_data":
          return this.page(args);
        case "get_map_buildings": {
          const [origin] = args.points;
          const rows = this.world.buildings
            .filter(({ position, can_scavenge, scavenged, stockroom }) => can_scavenge && !scavenged && !stockroom &&
              Math.hypot(position.x - origin.x, position.z - origin.z) <= args.radius)
            .map(({ id, position }) => ({ id, position }));
          return this.page({ ...args, category: "buildings" }, rows);
        }
        default:
          return { ok: false, code: "unknown_method", message: method };
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  status() {
    return { version: "0.1.0", ready: true, scene: "Game", session_id: this.sessionId, focused: true, mode: "test", ok: true };
  }

  getState() {
    // Clock drift only: nothing meaningful changes between polls.
    this.clockHour += 0.01;
    return {
      ...this.baseState,
      session_id: this.sessionId,
      time: { ...this.baseState.time, hour: Math.round(this.clockHour * 100) / 100, elapsed_game_seconds: this.baseState.time.elapsed_game_seconds + this.calls.length },
      squads: this.world.squads.map((row) => ({
        id: row.id, name: row.name, position: row.position, moving: false,
        in_vehicle: Boolean(row.vehicle_id), vehicle_id: row.vehicle_id, idle: !row.active_order,
      })),
    };
  }

  page({ session_id, category, limit = 100, offset = 0 }, rows = this.world[CATEGORY_FIELD[category]] ?? []) {
    if (!(category in CATEGORY_FIELD)) return { ok: false, code: "unknown_category", message: category };
    const end = offset + limit;
    return {
      session_id: session_id ?? this.sessionId,
      category, offset,
      next_offset: end < rows.length ? end : null,
      // Real bridge calls return freshly serialized JSON; clone so history snapshots
      // are not aliased to the mutable fake world.
      items: structuredClone(rows.slice(offset, end)),
      ok: true,
    };
  }

  // ---- mutation helpers used by tests -------------------------------------
  mutate(fn) { fn(this.world, this); }
  setSession(sessionId) { this.sessionId = sessionId; }
  goOffline() { this.online = false; }
  goOnline() { this.online = true; }
  callsFor(method) { return this.calls.filter((call) => call.method === method); }
}
