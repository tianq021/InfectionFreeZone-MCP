import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { summarizeThreats, registerExtraTools } from "../../tools-extra.mjs";
import { registerTools4 } from "../../tools-extra4.mjs";

const point = (x, z = 0) => ({ x, y: 0, z });
const group = (id, changes = {}) => ({ id, faction: "Bandits", type: "bandits", visible: true,
  affiliation_to_player: "Neutral", hostile_to_player: false, member_count: 3,
  position: point(100), destination: point(100), ...changes });
const threatSummary = groups => summarizeThreats(groups, { hq: point(0), maxDistance: 1200 });

function harness(groups, objectives = []) {
  const handlers = new Map(), calls = [];
  const state = { ok: true, session_id: "relations-session", headquarters: point(0), time: { hour: 12, sunset: 20 } };
  const options = {
    registerLocal: (name, description, schema, handler) => handlers.set(name, { schema: z.object(schema), handler }),
    request: async (method, args) => {
      calls.push(method);
      if (method === "get_state") return state;
      assert.equal(args.session_id, state.session_id);
      if (method === "get_world_data") {
        assert.ok(["groups", "squads", "vehicles", "stockpile", "worksites"].includes(args.category));
        return { ok: true, items: args.category === "groups" ? groups : [], next_offset: null };
      }
      if (method === "get_map_buildings") return { ok: true, items: [], next_offset: null };
      if (method === "get_missions") return { ok: true, missions: [{ id: "mission", objectives }] };
      assert.fail(`Unexpected request: ${method}`);
    },
  };
  registerExtraTools(options);
  registerTools4(options);
  return { calls, call: async (name, args = {}) => {
    const tool = handlers.get(name);
    return tool.handler(tool.schema.parse(args));
  } };
}

test("threat summary uses native relations for neutral Bandits and hostile Army/Provirus", () => {
  const r = threatSummary([
    group("neutral", { hostile_to_player: true }),
    group("indifferent", { faction: "Provirus", affiliation_to_player: "Indifferent", hostile_to_player: true }),
    group("army", { faction: "Army", affiliation_to_player: "Hostile", visible: false, position: point(200) }),
    group("provirus", { faction: "Provirus", affiliation_to_player: "Hostile", hostile_to_player: true }),
    group("own", { faction: "Infected", affiliation_to_player: "Own", hostile_to_player: true }),
  ]);
  assert.equal(r.count, 2);
  assert.deepEqual(r.nearest.map(g => g.groupId), ["provirus", "army"]);
  assert.ok(r.nearest.every(g => g.hostileToPlayer === true && g.relation_source === "native_affiliation"));
  assert.equal(r.nearest[1].attack_condition_hostile_flag, false);
  assert.equal(r.nearest[1].visible, false);
  assert.equal(r.relationship_coverage.native_relationships, 5);
});

test("legacy false flags remain unknown regardless of faction and visibility", () => {
  const r = threatSummary(["Bandits", "Infected", "Army", "Provirus"].flatMap(faction => [
    group(`${faction}-visible`, { faction, affiliation_to_player: undefined }),
    group(`${faction}-hidden`, { faction, affiliation_to_player: undefined, visible: false }),
  ]));
  assert.equal(r.count, 0);
  assert.equal(r.relationship_coverage.unknown_relationships, 8);
  assert.equal(r.relationship_coverage.native_relationships, 0);
});

test("unknown native enum is not overridden by a positive legacy flag; legacy player groups remain own", () => {
  const r = threatSummary([
    group("unknown", { affiliation_to_player: "FutureRelationship", hostile_to_player: true }),
    group("own", { faction: "Player", affiliation_to_player: undefined, hostile_to_player: true }),
  ]);
  assert.equal(r.count, 0);
  assert.equal(r.relationship_coverage.unknown_relationships, 1);
});

test("positive legacy flags include new factions with explicit source and coverage before distance filtering", () => {
  const r = threatSummary([
    group("army", { faction: "Army", affiliation_to_player: undefined, hostile_to_player: true }),
    group("provirus", { faction: "Provirus", affiliation_to_player: undefined, hostile_to_player: true }),
    group("far", { affiliation_to_player: "Hostile", position: point(2000) }),
    group("unknown", { affiliation_to_player: undefined }),
  ]);
  assert.equal(r.count, 2);
  assert.ok(r.nearest.every(g => g.relation_source === "legacy_positive_hostile_flag" && g.affiliation_to_player === null));
  assert.equal(r.relationship_coverage.scanned_groups, 4);
  assert.equal(r.relationship_coverage.unknown_relationships, 1);
});

test("get_threats preserves visibility, limits and total count with native affiliations", async () => {
  const h = harness([group("neutral"),
    group("army", { faction: "Army", affiliation_to_player: "Hostile", visible: false }),
    group("provirus", { faction: "Provirus", affiliation_to_player: "Hostile", position: point(200) }),
  ]);
  const all = await h.call("get_threats", { limit: 1 });
  assert.equal(all.count, 2);
  assert.equal(all.nearest.length, 1);
  const visible = await h.call("get_threats", { include_hidden: false });
  assert.equal(visible.count, 1);
  assert.equal(visible.nearest[0].groupId, "provirus");
  assert.ok(h.calls.every(method => method.startsWith("get_")));
});

test("recommendations exclude neutral Bandits, identify hostile Army, and expose unknown coverage", async () => {
  const neutral = await harness([group("neutral"), group("unknown", { affiliation_to_player: undefined })]).call("get_recommendations");
  assert.ok(neutral.recommendations.every(item => !["回防", "警戒"].includes(item.action)));
  assert.equal(neutral.relationship_coverage.unknown_relationships, 1);
  const hostile = await harness([group("army", { faction: "Army", affiliation_to_player: "Hostile" })]).call("get_recommendations");
  assert.ok(hostile.recommendations.some(item => item.action === "警戒" && item.detail.includes("army")));
});

test("mission kill candidates exclude neutral NPCs and retain hostile Army/Provirus attack-condition evidence", async () => {
  const h = harness([
    group("neutral", { hostile_to_player: true }),
    group("army", { faction: "Army", affiliation_to_player: "Hostile", visible: false }),
    group("provirus", { faction: "Provirus", affiliation_to_player: "Hostile", hostile_to_player: true }),
    group("unknown", { affiliation_to_player: undefined, visible: false }),
  ], [{ id: "kill", type: "KillGroup" }]);
  const r = await h.call("get_mission_plan");
  const action = r.plans[0].actions[0];
  assert.deepEqual(action.targets.map(g => g.groupId), ["army", "provirus"]);
  assert.equal(action.targets[0].visible, false);
  assert.equal(action.targets[0].attack_condition_hostile_flag, false);
  assert.equal(action.targets[0].affiliation_to_player, "Hostile");
  assert.match(action.note, /任务绑定/);
  assert.equal(r.relationship_coverage.unknown_relationships, 1);
  assert.equal(r.planCount, 1);
  assert.ok(h.calls.every(method => method.startsWith("get_")));
});

test("mission objective filters distinguish infected kills and hostile lairs after broadening faction coverage", async () => {
  const r = await harness([
    group("army", { faction: "Army", affiliation_to_player: "Hostile" }),
    group("provirus", { faction: "Provirus", affiliation_to_player: "Hostile" }),
    group("infected", { faction: "Infected", affiliation_to_player: "Hostile" }),
    group("lair", { faction: "Infected", affiliation_to_player: "Hostile", type: "hideout_inf_human" }),
    group("neutral-lair", { type: "hideout_bandits" }),
  ], [{ id: "infected", type: "DefeatInfected" }, { id: "lair", type: "ClearLair" }]).call("get_mission_plan");
  assert.deepEqual(r.plans[0].actions[0].targets.map(g => g.groupId), ["infected", "lair"]);
  assert.deepEqual(r.plans[0].actions[1].targets.map(g => g.groupId), ["lair"]);
});

test("mission with only unclassified groups reports unknown coverage without inventing attack targets", async () => {
  const r = await harness([
    group("visible", { affiliation_to_player: undefined }),
    group("hidden", { affiliation_to_player: undefined, visible: false }),
  ], [{ id: "kill", type: "KillCharacters" }]).call("get_mission_plan");
  assert.deepEqual(r.plans[0].actions[0].targets, []);
  assert.match(r.plans[0].actions[0].note, /关系未知/);
  assert.equal(r.relationship_coverage.unknown_relationships, 2);
});
