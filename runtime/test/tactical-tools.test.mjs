import test from "node:test";
import assert from "node:assert/strict";
import { registerTacticalTools } from "../../tools-tactical.mjs";

function harness(data = {}, extra = {}) {
  const handlers = new Map();
  const calls = [];
  registerTacticalTools({ registerLocal: (n, d, s, h) => handlers.set(n, h), request: async (m, a) => {
    calls.push(m);
    if (m === "get_state") return { ok: true, ready: true, session_id: "s1" };
    if (m === "get_world_data") return { ok: true, items: data[a.category] ?? [], next_offset: null };
    if (extra[m]) return { ok: true, ...extra[m] };
    throw Error(`Unexpected method ${m}`);
  } });
  return { call: (n, a = {}) => handlers.get(n)(a), calls };
}

test("wounded report deduplicates rosters and excludes full HP, dead and unknown", async () => {
  const person = { id: "1", hp: 25, max_hp: 100 };
  const h = harness({ citizens: [person, { id: "2", hp: 100, max_hp: 100 }], workers: [person],
    squads: [{ members: [{ id: "3", hp: 0, max_hp: 100 }, { id: "4", hp: null }, { id: "5", hp: 10, max_hp: 100 }] }] });
  const r = await h.call("get_wounded_report", { limit: 1 });
  assert.equal(r.total, 2); assert.equal(r.truncated, true); assert.equal(r.scanned_people, 5);
  assert.equal(r.items[0].id, "5"); assert.equal(r.unknown_health, 1);
});
test("readiness respects weapon ammo type, custom health thresholds and missing data", async () => {
  const h = harness({ squads: [{ id: "s", vehicle_id: "v", members: [
    { id: "a", hp: 60, max_hp: 100, ammo: 0, weapon_id: "rifle" },
    { id: "b", hp: null, ammo: 0, weapon_id: "axe" },
  ] }], weapons: [{ id: "rifle", ammo_id: "ammo" }, { id: "axe", ammo_id: null }], vehicles: [{ id: "v", fuel: { ratio: 0.1 } }] });
  const r = await h.call("get_squad_readiness", { low_hp_ratio: 0.7 });
  assert.deepEqual(r.items[0].empty_ammo_member_ids, ["a"]);
  assert.deepEqual(r.items[0].low_health_member_ids, ["a"]);
  assert.ok(r.items[0].flags.includes("low_vehicle_fuel"));
  assert.ok(r.items[0].flags.includes("incomplete_member_data"));
  await assert.rejects(h.call("get_squad_readiness", { squad_id: "missing" }), { code: "squad_unavailable" });
});
test("readiness exposes unknown ammunition, missing vehicles and sampled member lists", async () => {
  const h = harness({ squads: [{ id: "s", member_count: 40, vehicle_id: "missing", members: [
    { id: "a", hp: 100, max_hp: 100, weapon_id: "rifle", ammo: null },
  ] }], weapons: [{ id: "rifle", ammo_id: "ammo" }] });
  const row = (await h.call("get_squad_readiness")).items[0];
  assert.equal(row.vehicle_id, "missing");
  assert.equal(row.vehicle_data_available, false);
  assert.equal(row.fuel_ratio, null);
  assert.deepEqual(row.flags, ["member_roster_truncated", "incomplete_member_data", "incomplete_vehicle_data"]);
});
test("ammo report does not combine physical and virtual stock", async () => {
  const h = harness({ squads: [{ members: [{ weapon_id: "rifle", ammo: 0 }, { weapon_id: "rifle", ammo: null }] }],
    weapons: [{ id: "rifle", ammo_id: "ammo" }], stockpile: [
      { resource_id: "ammo", storage: "physical", available: 3, quantity: 5 },
      { resource_id: "ammo", storage: "virtual", available: 9, quantity: 9 },
    ] });
  const r = (await h.call("get_ammo_supply_report")).items[0];
  assert.equal(r.physical_available, 3); assert.equal(r.virtual_quantity, 9);
  assert.equal(r.empty_users, 1); assert.equal(r.unknown_ammo_users, 1);
});
test("ammo stock preserves unknown quantities rather than adding strings or null", async () => {
  const h = harness({ squads: [{ members: [{ weapon_id: "rifle", ammo: 1 }] }],
    weapons: [{ id: "rifle", ammo_id: "ammo" }], stockpile: [
      { resource_id: "ammo", storage: "physical", available: null, quantity: 5 },
      { resource_id: "ammo", storage: "virtual", quantity: "9" },
    ] });
  const row = (await h.call("get_ammo_supply_report")).items[0];
  assert.equal(row.physical_available, null);
  assert.equal(row.virtual_quantity, null);
});
test("nearby entities exclude hidden, missing positions and duplicate player groups", async () => {
  const p = { x: 3, z: 4 };
  const h = harness({ squads: [{ id: "s", position: p }], groups: [
    { id: "s", faction: "Player", visible: true, position: p },
    { id: "neutral", faction: "Bandits", visible: true, hostile_to_player: false, position: p },
    { id: "hidden", visible: false, position: p }, { id: "unknown", visible: true },
  ] });
  const r = await h.call("get_nearby_entities", { x: 0, z: 0 });
  assert.equal(r.total, 2); assert.equal(r.items[1].hostile_to_player, false);
  const hidden = await h.call("get_nearby_entities", { x: 0, z: 0, include_hidden: true, categories: ["groups", "groups"] });
  assert.equal(hidden.total, 3);
});
test("nearby groups deduplicate exact squad IDs and use unrounded radius boundaries", async () => {
  const h = harness({ squads: [{ id: "s", position: { x: 0, z: 0 } }], groups: [
    { id: "s", faction: "Player", visible: true, position: { x: 0, z: 0 } },
    { id: "other-player-group", faction: "Player", visible: true, position: { x: 0, z: 0 } },
    { id: "outside", visible: true, position: { x: 10.01, z: 0 } },
  ] });
  const result = await h.call("get_nearby_entities", { x: 0, z: 0, radius: 10, categories: ["groups", "squads"] });
  assert.deepEqual(result.items.map(row => row.id).sort(), ["other-player-group", "s"]);
});
test("return options rank real distances and do not count neutral bandits as hostile", async () => {
  const h = harness({ squads: [{ id: "s", position: { x: 0, z: 0 } }], stockrooms: [
    { id: "a", position: { x: 30, z: 40 } }, { id: "b", position: { x: 3, z: 4 } },
  ], groups: [{ faction: "Bandits", hostile_to_player: false, position: { x: 3, z: 4 } }] });
  const r = await h.call("get_return_options", { squad_id: "s" });
  assert.equal(r.items[0].stockroom_id, "b"); assert.equal(r.items[0].nearby_hostile_groups, 0);
  assert.equal(r.route_checked, false);
  assert.ok(h.calls.every(m => m.startsWith("get_")));
});
test("mission report preserves native timing fields and objective completion", async () => {
  const h = harness({}, { get_missions: { missions: [{ id: "m", time_to_resolve: 12, time_to_resolve01: 0.5,
    chapter_id: "chapter", blocking_new_zone: true, objectives: [{ completed: true }, { completed: false }] }] } });
  const r = (await h.call("get_mission_deadlines")).items[0];
  assert.equal(r.time_to_resolve, 12); assert.equal(r.time_to_resolve01, 0.5);
  assert.equal(r.completed_objectives, 1); assert.equal(r.chapter_id, "chapter");
});
test("mission objectives omitted by the bridge stay unknown", async () => {
  const h = harness({}, { get_missions: { missions: [{ id: "m" }] } });
  const row = (await h.call("get_mission_deadlines")).items[0];
  assert.equal(row.objective_count, null);
  assert.equal(row.completed_objectives, null);
});
