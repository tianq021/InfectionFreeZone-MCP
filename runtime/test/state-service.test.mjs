// Tests for the unified state service (P0). Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { StateService } from "../state-service.mjs";
import { FakeBridge } from "./fake-bridge.mjs";
import { TEST_HQ, TEST_SESSION } from "./fixtures.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silentLogger = { log() {}, error() {}, warn() {} };

function setup({ bridgeOptions = {}, config = {} } = {}) {
  const bridge = new FakeBridge(bridgeOptions);
  const service = new StateService({
    pipe: bridge,
    logger: silentLogger,
    config: { fastIntervalMs: 60, mediumIntervalMs: 60, slowIntervalMs: 60, includeBuildings: true, ...config },
  });
  return { bridge, service };
}

const findEvent = (service, type) => service.events.find((event) => event.type === type);

test("首次轮询建立快照，并按类目并发读取", async () => {
  const { bridge, service } = setup({ bridgeOptions: { latencyMs: 5 } });
  await service.pollOnce();
  assert.equal(service.version, 1);
  assert.equal(service.ready, true);
  assert.equal(service.state.sessionId, TEST_SESSION);
  assert.equal(service.state.squads.length, 3);
  assert.equal(service.state.groups.length, 6);
  assert.equal(service.state.stockrooms.length, 1);
  assert.ok(bridge.maxInFlight >= 2, `expected concurrent reads, got ${bridge.maxInFlight}`);
  assert.equal(findEvent(service, "bridge_offline"), undefined);
  service.stop();
});

test("时钟漂移不算状态变化：版本不变、长轮询不误唤醒", async () => {
  const { service } = setup();
  await service.pollOnce();
  const version = service.version;
  for (let i = 0; i < 3; i++) await service.pollOnce();
  assert.equal(service.version, version, "game clock advancing must not bump version");
  const timeout = await service.waitForChange({ since: version, timeoutMs: 60 });
  assert.equal(timeout.changed, false, "clock-only ticks must not resolve the waiter");
  service.stop();
});

test("差分只包含变化记录和变化字段", async () => {
  const { bridge, service } = setup();
  await service.pollOnce();
  const from = service.version;
  bridge.mutate((world) => {
    world.squads[1].position = { x: 1330, y: 25, z: 1490 };
  });
  await service.pollOnce();
  assert.equal(service.version, from + 1);
  const delta = service.getCurrent({ since: from });
  assert.equal(delta.changed, true);
  const updated = delta.delta.squads?.updated ?? [];
  const squad = updated.find((row) => row.id === "835");
  assert.ok(squad, "squad 835 should be in the updated list");
  assert.ok(squad.changes.some((change) => change.path === "position.x"), JSON.stringify(squad.changes));
  assert.equal(delta.delta.squads?.added?.length ?? 0, 0);
  const state = service.getCurrent({});
  assert.equal(state.full, true);
  service.stop();
});

test("岗位变化进入差分，且不会唤醒只订阅小队的读者", async () => {
  const { bridge, service } = setup();
  bridge.world.worksites = [{ building_id: "site", workers: 1 }];
  await service.pollOnce();
  if (service.mapCache.pending) await service.mapCache.pending;
  await service.pollOnce();
  const since = service.version;
  const squads = service.waitForChange({ since, categories: ["squads"], timeoutMs: 500 });
  const worksites = service.waitForChange({ since, categories: ["worksites"], timeoutMs: 500 });
  bridge.world.worksites[0].workers = 2;
  await service.pollOnce({ forceSlow: true });
  const worksiteChange = await worksites;
  assert.deepEqual(worksiteChange.delta.worksites.updated, [{ id: "site", changes: [{ path: "workers", value: 2 }] }]);
  assert.equal(service.getCurrent({ since, categories: ["squads"] }).changed, false);
  bridge.world.squads[1].position.x++;
  await service.pollOnce();
  assert.ok((await squads).delta.squads.updated.length);
  service.stop();
});

test("语义事件：敌情分级逼近 + 去重", async () => {
  const { bridge, service } = setup();
  await service.pollOnce();
  // 敌群 g1 从 268 m 推进到 ~99 m（warn）
  bridge.mutate((world) => { world.groups[3].position = { x: 1430, y: 25, z: TEST_HQ.z }; });
  await service.pollOnce();
  const warn = findEvent(service, "enemy_approach");
  assert.ok(warn, "expected enemy_approach");
  assert.equal(warn.severity, "warn");
  assert.equal(warn.data.groupId, "g1");
  // 同样距离不变 → 不重复上报
  const countBefore = service.events.filter((event) => event.type === "enemy_approach").length;
  await service.pollOnce();
  assert.equal(service.events.filter((event) => event.type === "enemy_approach").length, countBefore);
  // 推进到 ~49 m（critical）
  bridge.mutate((world) => { world.groups[3].position = { x: 1380, y: 25, z: TEST_HQ.z }; });
  await service.pollOnce();
  const critical = service.events.filter((event) => event.type === "enemy_approach").at(-1);
  assert.equal(critical.severity, "critical");
  service.stop();
});

test("语义事件：低血、订单完成、事件长轮询", async () => {
  const { bridge, service } = setup();
  await service.pollOnce();
  const cursor = service.eventCursor;
  const waiting = service.waitForEvents({ cursor, timeoutMs: 500 });
  await sleep(10);
  bridge.mutate((world) => { world.squads[1].members[0].hp = 50; });
  await service.pollOnce();
  const lowHp = findEvent(service, "squad_low_hp");
  assert.ok(lowHp, "expected squad_low_hp");
  assert.equal(lowHp.severity, "warn");
  assert.equal(lowHp.data.squadId, "835");
  const polled = await waiting;
  assert.equal(polled.changed, true);
  assert.ok(polled.events.some((event) => event.type === "squad_low_hp"));
  // 订单完成
  bridge.mutate((world) => { world.squads[1].active_order = null; });
  await service.pollOnce();
  const done = findEvent(service, "order_completed");
  assert.ok(done, "expected order_completed");
  assert.equal(done.data.squadId, "835");
  service.stop();
});

test("长轮询：变化时立即返回增量，无变化时超时", async () => {
  const { bridge, service } = setup();
  await service.pollOnce();
  const from = service.version;
  const waiting = service.waitForChange({ since: from, timeoutMs: 500 });
  await sleep(10);
  bridge.mutate((world) => { world.vehicles[0].fuel.ratio = 0.4; });
  await service.pollOnce();
  const result = await waiting;
  assert.equal(result.changed, true);
  assert.equal(result.version, from + 1);
  assert.ok(result.delta.vehicles?.updated?.some((row) => row.id === "781"));
  const timeout = await service.waitForChange({ since: service.version, timeoutMs: 40 });
  assert.equal(timeout.changed, false);
  assert.equal(timeout.timeout, true);
  service.stop();
});

test("会话切换：清空缓存、重读中层数据、上报 session_changed", async () => {
  const { bridge, service } = setup();
  await service.pollOnce();
  const versionBefore = service.version;
  bridge.setSession("session-test-2");
  await service.pollOnce();
  assert.equal(service.state.sessionId, "session-test-2");
  assert.ok(service.version > versionBefore);
  const changed = findEvent(service, "session_changed");
  assert.ok(changed, "expected session_changed");
  assert.equal(changed.data.sessionId, "session-test-2");
  assert.ok(service.state.stockpile.length > 0, "medium cache should be refetched for the new session");
  service.stop();
});

test("桥接掉线与恢复：事件只报一次，恢复后 online", async () => {
  const { bridge, service } = setup();
  await service.pollOnce();
  bridge.goOffline();
  await assert.rejects(() => service.pollOnce(), /bridge offline/);
  assert.equal(service.health().online, false);
  assert.ok(findEvent(service, "bridge_offline"), "expected bridge_offline");
  // 持续离线不重复上报
  await assert.rejects(() => service.pollOnce());
  assert.equal(service.events.filter((event) => event.type === "bridge_offline").length, 1);
  bridge.goOnline();
  await service.pollOnce();
  assert.equal(service.health().online, true);
  assert.ok(findEvent(service, "bridge_restored"), "expected bridge_restored");
  service.stop();
});

test("建筑只分页读取总部周边候选，群组查询保持全图范围", async () => {
  const { bridge, service } = setup({ bridgeOptions: { buildingCount: 250 }, config: { slowIntervalMs: 60000 } });
  bridge.world.buildings.forEach((building, index) => {
    building.position = { ...TEST_HQ, x: TEST_HQ.x + index / 2 };
  });
  const farBuilding = bridge.world.buildings[248];
  farBuilding.position.x = TEST_HQ.x + 500;
  bridge.world.groups[0].position = { ...TEST_HQ, x: TEST_HQ.x + 500 };
  await service.pollOnce();
  await service.mapCache.pending;
  await service.pollOnce();
  const buildingPages = bridge.callsFor("get_map_buildings");
  assert.deepEqual(buildingPages.map((call) => call.args.offset), [0, 100]);
  assert.ok(buildingPages.every((call) => call.args.radius === 200 && call.args.scavenge_only));
  assert.deepEqual(buildingPages[0].args.points, [{ x: TEST_HQ.x, z: TEST_HQ.z }]);
  assert.ok(bridge.callsFor("get_world_data").every(({ args }) => args.category !== "buildings"));
  const expected = bridge.world.buildings.filter((building) => building !== farBuilding &&
    building.can_scavenge && !building.scavenged && !building.stockroom).length;
  assert.equal(service.state.buildings.length, expected);
  assert.ok(service.state.buildings.every((building) => building.id !== farBuilding.id));
  assert.ok(service.state.groups.some(({ id }) => id === bridge.world.groups[0].id));
  service.stop();
});

test("地图请求卡住或返回坏数据时继续更新单位", { timeout: 2000 }, async () => {
  const { bridge, service } = setup({ config: { slowIntervalMs: 60000 } });
  const call = bridge.call.bind(bridge);
  let finishMap;
  const mapReply = new Promise((resolve) => { finishMap = resolve; });
  bridge.call = (method, args) => method === "get_map_buildings" ? mapReply : call(method, args);

  await service.pollOnce();
  assert.ok(service.mapCache.pending);
  bridge.world.groups[0].position.x += 20;
  await service.pollOnce();
  assert.equal(service.state.groups[0].position.x, bridge.world.groups[0].position.x);

  finishMap({ ok: true, items: [null], next_offset: null });
  await service.mapCache.pending;
  assert.equal(service.health().mapError.code, "invalid_map_reply");
  assert.equal(service.health().lastError, null);
  assert.equal(service.health().stats.pollErrors, 0);
  assert.equal(service.health().online, true);

  bridge.call = call;
  await service.pollOnce({ forceSlow: true });
  await service.mapCache.pending;
  assert.equal(service.health().mapError, null);
  service.stop();
});

test("健康指标包含轮询统计与版本", async () => {
  const { service } = setup();
  await service.pollOnce();
  const health = service.health();
  assert.equal(health.ok, true);
  assert.equal(health.online, true);
  assert.equal(health.version, 1);
  assert.equal(health.sessionId, TEST_SESSION);
  assert.ok(health.stats.pollSeq >= 1);
  assert.ok(health.stats.bridgeCalls >= 1);
  service.stop();
});
