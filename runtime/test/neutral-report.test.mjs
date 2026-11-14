import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerEnemyTools } from "../../tools-extra3.mjs";

const point = (x, z = 0) => ({ x, y: 0, z });
const group = (id, changes = {}) => ({ id, faction: "Immigrants", type: "immigrants", visible: true,
  affiliation_to_player: "Neutral", hostile_to_player: false, can_be_attacked: true,
  member_count: 3, members: [{ weapon_id: "eq_pistol", hp: 90, max_hp: 100 }],
  position: point(10), destination: point(10), ...changes });

function harness(groups, { squads = [], state: changes = {}, override } = {}) {
  const state = { ok: true, ready: true, session_id: "settlement-a", headquarters: point(0), time: { day: 6 }, ...changes };
  const tools = new Map(), calls = [];
  registerEnemyTools({ registerLocal: (name, description, schema, handler) => tools.set(name, { description, schema: z.object(schema), handler }),
    request: async (method, args) => {
      calls.push({ method, args });
      const response = override?.(method, args);
      if (response !== undefined) return response;
      if (method === "get_state") return state;
      assert.equal(args.session_id, state.session_id);
      assert.equal(method, "get_world_data", "Tests must not issue game writes");
      const items = { groups, squads, weapons: [] }[args.category];
      assert.ok(items, `Unexpected category ${args.category}`);
      const offset = args.offset ?? 0, limit = args.limit ?? 100;
      return { ok: true, session_id: state.session_id, items: items.slice(offset, offset + limit), next_offset: offset + limit < items.length ? offset + limit : null };
    } });
  return { calls, call: (name = "get_neutral_report", args = {}) => {
    const tool = tools.get(name);
    return tool.handler(tool.schema.parse(args));
  } };
}

test("neutral report reads real NPC affiliation and communications without variant ReferenceError", async () => {
  const h = harness([group("npc", { npc_zone_member: true, immigrants_state: "WaitingForTransmission" })]);
  const r = await h.call();
  assert.equal(r.count, 1);
  assert.equal(r.confirmed_non_hostile_groups, 1);
  assert.equal(r.groups[0].npc_zone_member, true);
  assert.equal(r.groups[0].immigrants_state, "WaitingForTransmission");
  assert.equal(r.groups[0].affiliation_to_player, "Neutral");
  assert.equal(r.groups[0].attackable, true);
  assert.equal(r.groups[0].hostileToPlayer, false);
  assert.ok(!Object.hasOwn(r.groups[0], "variants"));
  assert.ok(h.calls.every(call => call.method.startsWith("get_")));
});

test("native neutral Bandits and indifferent Provirus are included even with contradictory legacy flag", async () => {
  const r = await harness([group("bandit", { faction: "Bandits", hostile_to_player: true }),
    group("provirus", { faction: "Provirus", affiliation_to_player: "Indifferent", hostile_to_player: true })]).call();
  assert.deepEqual(r.groups.map(g => g.groupId), ["bandit", "provirus"]);
  assert.ok(r.groups.every(g => g.hostileToPlayer === false && g.relation_source === "native_affiliation"));
});

test("legacy visible non-hostile flags remain explicitly unclassified observations", async () => {
  const r = await harness([group("bandit", { faction: "Bandits", affiliation_to_player: undefined, can_be_attacked: undefined })]).call();
  assert.equal(r.count, 1);
  assert.equal(r.confirmed_non_hostile_groups, 0);
  assert.equal(r.legacy_visible_unclassified_groups, 1);
  assert.equal(r.groups[0].affiliation_to_player, null);
  assert.equal(r.groups[0].hostileToPlayer, null);
  assert.equal(r.groups[0].attackable, null);
  assert.equal(r.groups[0].relation_source, "legacy_visible_unclassified");
});

test("hidden or missing legacy relationships are unknown rather than neutral", async () => {
  const r = await harness([group("hidden", { affiliation_to_player: undefined, visible: false }),
    group("missing", { affiliation_to_player: undefined, hostile_to_player: undefined }),
    group("invalid", { affiliation_to_player: "FutureRelationship" }),
    group("positive", { affiliation_to_player: undefined, hostile_to_player: true })]).call();
  assert.equal(r.count, 0);
  assert.equal(r.excluded_unknown_relationship, 3);
});

test("native hostile factions and all own groups are excluded from neutral report", async () => {
  const r = await harness([
    group("hostile", { faction: "Army", affiliation_to_player: "Hostile", visible: false }),
    group("own", { affiliation_to_player: "Own" }),
    group("player", { faction: "Player" }), group("squad"), group("neutral"),
  ], { squads: [{ id: "squad" }] }).call();
  assert.deepEqual(r.groups.map(g => g.groupId), ["neutral"]);
});

test("visibility and wildlife switches respect explicit affiliations", async () => {
  const h = harness([group("hidden", { visible: false }), group("animal", { faction: "Animals" }), group("visible")]);
  assert.equal((await h.call()).count, 3);
  const filtered = await h.call("get_neutral_report", { include_hidden: false, include_animals: false });
  assert.deepEqual(filtered.groups.map(g => g.groupId), ["visible"]);
});

test("default 3000-unit radius and exact boundaries apply before rounding", async () => {
  const h = harness([group("inside", { position: point(2999.99) }), group("edge", { position: point(3000) }),
    group("outside", { position: point(3000.01) })]);
  assert.deepEqual((await h.call()).groups.map(g => g.groupId), ["inside", "edge"]);
  assert.equal((await h.call("get_neutral_report", { radius: 4000 })).count, 3);
});

test("missing positions are counted rather than substituted, and missing HQ rejects the report", async () => {
  const r = await harness([group("missing", { position: null }), group("bad", { position: point(NaN) }), group("valid")]).call();
  assert.equal(r.count, 1); assert.equal(r.excluded_unknown_position, 2);
  await assert.rejects(harness([group("valid")], { state: { headquarters: null } }).call(), { code: "headquarters_unavailable" });
});

test("missing member totals and attackability remain unknown", async () => {
  const r = await harness([group("missing", { member_count: null, can_be_attacked: null, npc_zone_member: undefined })]).call();
  assert.equal(r.unknownMemberCountGroups, 1);
  assert.equal(r.groups[0].members, null);
  assert.equal(r.groups[0].sampled_members, 1);
  assert.equal(r.groups[0].attackable, null);
  assert.equal(r.groups[0].npc_zone_member, null);
});

test("all source pages feed totals while output is bounded", async () => {
  const h = harness(Array.from({ length: 105 }, (_, i) => group(String(i), { position: point(i) })));
  const r = await h.call("get_neutral_report", { limit: 5 });
  assert.equal(r.count, 105); assert.equal(r.totalMembers, 315);
  assert.equal(r.returned_count, 5); assert.equal(r.truncated, true);
  assert.deepEqual(r.groups.map(g => g.groupId), ["0", "1", "2", "3", "4"]);
  assert.ok(h.calls.some(c => c.method === "get_world_data" && c.args.category === "groups" && c.args.offset === 100));
});

test("malformed pages, bridge errors and session changes fail instead of producing empty peace", async () => {
  for (const [response, code] of [
    [{ ok: false, code: "bridge_offline" }, "bridge_offline"],
    [{ ok: true, session_id: "other", items: [], next_offset: null }, "session_changed"],
    [{ ok: true, items: [group("a")], next_offset: 0 }, "invalid_page"],
  ]) {
    const h = harness([], { override: (method, args) => method === "get_world_data" && args.category === "groups" ? response : undefined });
    await assert.rejects(h.call(), { code });
  }
});

test("native enemy reports recognize Army and Provirus while excluding neutral Bandits", async () => {
  const r = await harness([group("army", { faction: "Army", affiliation_to_player: "Hostile" }),
    group("purifier", { faction: "Provirus", affiliation_to_player: "Hostile", visible: false }),
    group("bandit", { faction: "Bandits", affiliation_to_player: "Neutral", hostile_to_player: true }),
    group("unknown", { faction: "Infected", affiliation_to_player: undefined, visible: false }),
  ]).call("get_enemy_report");
  assert.deepEqual(r.groups.map(g => g.groupId), ["army", "purifier"]);
  assert.equal(r.relationship_coverage.unknown_relationships, 1);
  assert.ok(r.groups.every(g => g.hostileToPlayer === true));
  assert.deepEqual(r.groups[0].variants, {});
});

test("combat estimation rejects native neutral even if old hostile flag is true", async () => {
  const r = await harness([group("bandit", { faction: "Bandits", hostile_to_player: true })]).call("get_combat_estimate", { group_id: "bandit" });
  assert.equal(r.code, "invalid_attack_target");
});

test("new report bounds reject invalid calls before bridge access", async () => {
  const h = harness([]);
  for (const args of [{ limit: 0 }, { limit: 101 }, { radius: 99 }, { radius: Infinity }, { include_hidden: "yes" }]) {
    assert.throws(() => h.call("get_neutral_report", args));
  }
  assert.equal(h.calls.length, 0);
});
