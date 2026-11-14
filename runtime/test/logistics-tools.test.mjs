import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerLogisticsTools } from "../../tools-logistics.mjs";

const point = (x, z = 0) => ({ x, y: 0, z });
function harness({ world: changes = {}, state: stateChanges = {}, override } = {}) {
  const calls = [], registered = new Map();
  const state = { ok: true, ready: true, session_id: "settlement-a", headquarters: point(0), ...stateChanges };
  const world = {
    stockpile: [
      { storage: "physical", resource_id: "res_wood", quantity: 12, available: 7 },
      { storage: "virtual", resource_id: "res_wood", quantity: 100, available: 95 },
      { storage: "physical", resource_id: "res_ammo", quantity: 4, available: 2 },
    ],
    resource_types: [{ resource_id: "res_wood" }, { resource_id: "res_ammo" }, { resource_id: "res_metal" }, { resource_id: "eq_pistol" }],
    weapons: [{ id: "eq_pistol", ammo_id: "res_ammo", melee: false, magazine_capacity: 10 }],
    squads: [
      { id: "s1", name: "One", position: point(10), vehicle_id: "v1", cargo: { res_wood: 3 } },
      { id: "s2", name: "Two", position: point(90), cargo: {} },
    ],
    vehicles: [
      { id: "v1", type: "ve_sedan", position: point(20), owner_group_id: "s1", trunk: { occupied_slots: 2, capacity_slots: 10, available_slots: 8, cargo: { res_wood: 5, res_ammo: 1 } }, fuel: { quantity: 3, capacity: 10, ratio: 0.3 } },
      { id: "v2", type: "ve_sedan", position: point(30), owner_group_id: "npc", trunk: { cargo: { res_wood: 1000 } } },
      { id: "v3", type: "ve_sedan", position: point(35), owner_group_id: null, trunk: { cargo: { res_wood: 2000 } } },
    ],
    ground_resources: [
      { id: "g1", resource_id: "res_wood", quantity: 8, position: point(60) },
      { id: "g2", resource_id: "res_ammo", quantity: 2, position: point(5) },
      { id: "g3", resource_id: "res_wood", quantity: 4, position: null },
    ],
    stockrooms: [{ id: "r1", headquarters: true, position: point(0) }, { id: "r2", headquarters: false, position: point(100) }],
    workforce: [
      { task_id: "t1", task_type: "ProductionWork", position: point(10), assigned_workers: 2, working_workers: 1, can_execute: true, paused: false, suspended: false },
      { task_id: "t2", task_type: "RepairWork", position: point(60), assigned_workers: 0, working_workers: 0, can_execute: false, paused: false, suspended: false },
      { task_id: "t3", task_type: "ProductionWork", position: null, assigned_workers: 1, working_workers: 0 },
    ],
    ...changes,
  };
  registerLogisticsTools({
    registerLocal(name, description, schema, handler) { registered.set(name, { description, schema: z.object(schema), handler }); },
    async request(method, args) {
      calls.push({ method, args });
      const replacement = override?.(method, args);
      if (replacement !== undefined) return replacement;
      if (method === "get_state") return state;
      assert.equal(args.session_id, state.session_id);
      assert.ok(["get_world_data", "get_workforce"].includes(method), `Unexpected mutating or unsupported call ${method}`);
      const items = world[method === "get_workforce" ? "workforce" : args.category];
      assert.ok(items, `Missing category ${args.category}`);
      return { ok: true, session_id: state.session_id, offset: args.offset, items: items.slice(args.offset, args.offset + args.limit),
        next_offset: args.offset + args.limit < items.length ? args.offset + args.limit : null };
    },
  });
  return { calls, registered, async call(name, args = {}) {
    const tool = registered.get(name);
    assert.ok(tool, `Missing tool ${name}`);
    return tool.handler(tool.schema.parse(args));
  } };
}

test("stock report separates containers and exchange-unavailable stock, including output pagination", async () => {
  const h = harness();
  const result = await h.call("get_stockpile_report", { resource_id: "res_wood", limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.next_offset, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items, [{ storage: "physical", resource_id: "res_wood", quantity: 12, available: 7, unavailable_during_exchange: 5 }]);
  const next = await h.call("get_stockpile_report", { resource_id: "res_wood", limit: 1, offset: 1 });
  assert.equal(next.items[0].storage, "virtual");
  assert.equal(next.next_offset, null);
});

test("catalog joins weapon ammo without claiming current unlisted IDs are editable", async () => {
  const h = harness({ world: { stockpile: [{ resource_id: "res_scientificmaterial", storage: "physical", quantity: 2, available: 2 }] } });
  const weapon = (await h.call("get_resource_catalog", { search: "PISTOL" })).items[0];
  assert.deepEqual(weapon.weapon, { melee: false, ammo_id: "res_ammo", magazine_capacity: 10 });
  const scientific = (await h.call("get_resource_catalog", { search: "scientific" })).items[0];
  assert.equal(scientific.listed_as_editable, false);
  assert.deepEqual(scientific.observed_storage, ["physical"]);
});

test("budget adds duplicate requests, uses available stock, and never borrows virtual stock", async () => {
  const h = harness();
  const requirements = [{ resource_id: "res_wood", quantity: 5 }, { resource_id: "res_wood", quantity: 4 }, { resource_id: "res_metal", quantity: 1 }];
  const result = await h.call("get_resource_budget", { requirements });
  assert.equal(result.affordable, false);
  assert.equal(result.shortage_count, 2);
  assert.deepEqual(result.items.find(row => row.resource_id === "res_wood"), {
    resource_id: "res_wood", requested: 9, quantity: 12, available: 7, shortage: 2, affordable: false,
  });
  assert.equal(result.items.find(row => row.resource_id === "res_metal").available, 0);
  const virtual = await h.call("get_resource_budget", { requirements: requirements.slice(0, 2), storage: "virtual" });
  assert.equal(virtual.affordable, true);
  assert.equal(virtual.items[0].available, 95);
  await assert.rejects(h.call("get_resource_budget", { requirements: [{ resource_id: "typo", quantity: 1 }] }), { code: "unknown_resource" });
});

test("unknown availability stays unknown instead of being spendable or silently zero", async () => {
  const h = harness({ world: { stockpile: [{ storage: "physical", resource_id: "res_wood", quantity: 20 }] } });
  const result = await h.call("get_resource_budget", { requirements: [{ resource_id: "res_wood", quantity: 1 }] });
  assert.equal(result.affordable, null);
  assert.equal(result.items[0].available, null);
  assert.equal((await h.call("get_stockpile_report")).items[0].unavailable_during_exchange, null);
});

test("locations separate stock from actual cargo and exclude NPC/unowned vehicles by default", async () => {
  const h = harness();
  const result = await h.call("get_resource_locations", { resource_id: "res_wood" });
  assert.equal(result.total, 4);
  assert.deepEqual(result.items.map(row => row.id), ["s1", "v1", "g1", "g3"]);
  assert.equal(result.items.at(-1).distance_m, null);
  assert.equal(result.shared_stock.length, 2);
  const expanded = await h.call("get_resource_locations", { resource_id: "res_wood", include_other_vehicles: true, limit: 2 });
  assert.equal(expanded.total, 6);
  assert.equal(expanded.truncated, true);
  assert.equal(expanded.items.length, 2);
});

test("ground report uses valid geometry, includes all matching resources in summary, and resolves nearest warehouse", async () => {
  const h = harness();
  const result = await h.call("get_ground_resources_report", { resource_id: "res_wood", radius: 80 });
  assert.equal(result.total, 1);
  assert.deepEqual(result.items[0].nearest_stockroom, { id: "r2", distance_m: 40 });
  assert.deepEqual(result.resources.items, [{ resource_id: "res_wood", quantity: 8 }]);
  const unfiltered = await h.call("get_ground_resources_report", { limit: 1 });
  assert.equal(unfiltered.total, 3);
  assert.equal(unfiltered.items[0].id, "g2");
  assert.equal(unfiltered.resources.total, 2);
  const missingOrigin = harness({ state: { headquarters: null } });
  await assert.rejects(missingOrigin.call("get_ground_resources_report", { radius: 10 }), { code: "origin_unavailable" });
});

test("storage report determines return catchments without inventing per-warehouse quantities", async () => {
  const h = harness();
  const result = await h.call("get_storage_report");
  assert.deepEqual(result.items.map(row => row.nearest_for_squad_count), [1, 1]);
  assert.deepEqual(result.items[0].nearest_squad, { id: "s1", distance_m: 10 });
  assert.equal(result.items[0].inventory, null);
  assert.equal(result.items[0].capacity, null);
  const noRooms = await harness({ world: { stockrooms: [] } }).call("get_storage_report");
  assert.equal(noRooms.squads_without_known_return_point, 2);
});

test("supply network ranks remote tasks, preserves missing positions and filters staffing", async () => {
  const h = harness();
  const result = await h.call("get_supply_network");
  assert.deepEqual(result.items.map(row => row.task_id), ["t2", "t1", "t3"]);
  assert.equal(result.tasks_without_known_stockroom, 1);
  assert.equal(result.items[0].can_execute, false);
  const staffed = await h.call("get_supply_network", { only_staffed: true, min_distance: 5 });
  assert.deepEqual(staffed.items.map(row => row.task_id), ["t1"]);
  assert.equal(staffed.items[0].nearest_stockroom.distance_m, 10);
});

test("manifest counts native packs/trunks once, excludes NPC cargo even when shown and distinguishes slots", async () => {
  const h = harness();
  const result = await h.call("get_cargo_manifest", { include_other_vehicles: true, resource_id: "res_wood", limit: 1 });
  assert.equal(result.total, 4);
  assert.deepEqual(result.player_cargo_resources.items, [{ resource_id: "res_wood", quantity: 8 }]);
  const player = await h.call("get_cargo_manifest");
  assert.equal(player.total, 2);
  const vehicle = player.items.find(row => row.kind === "vehicle");
  assert.equal(vehicle.occupied_slots, 2);
  assert.equal(vehicle.cargo.find(row => row.resource_id === "res_wood").quantity, 5);
  assert.equal(vehicle.fuel_quantity, 3);
  assert.deepEqual(vehicle.nearest_stockroom, { id: "r1", distance_m: 20 });
});

test("all source pages are read before bounded output and no write method is used", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ resource_id: `res_${String(i).padStart(3, "0")}`, storage: "physical", quantity: 1, available: 1 }));
  const h = harness({ world: { stockpile: rows } });
  const result = await h.call("get_stockpile_report", { offset: 200, limit: 10 });
  assert.equal(result.total, 205);
  assert.equal(result.items.length, 5);
  assert.deepEqual(h.calls.filter(row => row.method === "get_world_data").map(row => row.args.offset), [0, 100, 200]);
  assert.ok(h.calls.every(row => ["get_state", "get_world_data"].includes(row.method)));
});

test("bridge failure and session changes fail the report instead of returning a partial success", async () => {
  const offline = harness({ override: method => method === "get_state" ? { ok: false, code: "bridge_offline", message: "offline" } : undefined });
  await assert.rejects(offline.call("get_cargo_manifest"), { code: "bridge_offline" });
  const changed = harness({ override: method => method === "get_world_data" ? { ok: true, session_id: "other", items: [], next_offset: null } : undefined });
  await assert.rejects(changed.call("get_stockpile_report"), { code: "session_changed" });
  const failure = harness({ override: (method, args) => args?.category === "vehicles" ? { ok: false, code: "bridge_busy", message: "busy" } : undefined });
  await assert.rejects(failure.call("get_cargo_manifest"), { code: "bridge_busy" });
});

test("schemas reject unbounded output, negative demands and invalid origin coordinates", async () => {
  const h = harness();
  await assert.rejects(h.call("get_stockpile_report", { limit: 101 }));
  await assert.rejects(h.call("get_resource_budget", { requirements: [{ resource_id: "res_wood", quantity: -1 }] }));
  await assert.rejects(h.call("get_ground_resources_report", { origin: { x: Infinity, z: 0 } }));
  assert.equal(h.calls.length, 0);
});
