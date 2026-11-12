// Tests for the local HTTP API (hub). Run: node --test runtime/test/
import test from "node:test";
import assert from "node:assert/strict";
import { StateService } from "../state-service.mjs";
import { createHub } from "../hub.mjs";
import { FakeBridge } from "./fake-bridge.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silentLogger = { log() {}, error() {}, warn() {} };

async function setup() {
  const bridge = new FakeBridge({ buildingCount: 120 });
  const service = new StateService({
    pipe: bridge,
    logger: silentLogger,
    config: { includeBuildings: false },
  });
  await service.pollOnce();
  const hub = createHub({ stateService: service, port: 0, logger: silentLogger });
  const port = await hub.listen();
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, `${path} -> ${response.status}`);
    return response.json();
  };
  const close = async () => {
    service.stop();
    await hub.close();
  };
  return { bridge, service, hub, base, get, close };
}

test("hub: health 与根路由", async () => {
  const context = await setup();
  try {
    const health = await context.get("/health");
    assert.equal(health.ok, true);
    assert.equal(health.online, true);
    assert.equal(health.version, 1);
    const index = await context.get("/");
    assert.equal(index.service, "ifz-runtime");
    assert.ok(index.routes.some((route) => route.startsWith("/state/wait")));
  } finally {
    await context.close();
  }
});

test("hub: /state 全量与无变化增量", async () => {
  const context = await setup();
  try {
    const full = await context.get("/state");
    assert.equal(full.full, true);
    assert.equal(full.state.squads.length, 3);
    const unchanged = await context.get(`/state?since=${full.version}`);
    assert.equal(unchanged.changed, false);
  } finally {
    await context.close();
  }
});

test("hub: 变化后 /state?since 返回差分，/state/wait 长轮询返回", async () => {
  const context = await setup();
  try {
    const full = await context.get("/state");
    const from = full.version;
    context.bridge.mutate((world) => { world.squads[2].position = { x: 1400, y: 25, z: 1300 }; });
    await context.service.pollOnce();
    const delta = await context.get(`/state?since=${from}`);
    assert.equal(delta.changed, true);
    assert.ok(delta.delta.squads.updated.some((row) => row.id === "836"));
    const since = context.service.version;
    const waiting = context.get(`/state/wait?since=${since}&timeoutMs=500`);
    await sleep(20);
    context.bridge.mutate((world) => { world.squads[2].position = { x: 1410, y: 25, z: 1305 }; });
    await context.service.pollOnce();
    const waited = await waiting;
    assert.equal(waited.changed, true);
    assert.ok(waited.version > since);
  } finally {
    await context.close();
  }
});

test("hub: /state/wait 无变化时超时返回 changed:false", async () => {
  const context = await setup();
  try {
    const result = await context.get(`/state/wait?since=${context.service.version}&timeoutMs=40`);
    assert.equal(result.changed, false);
    assert.equal(result.timeout, true);
    assert.ok(result.waitedMs >= 30);
  } finally {
    await context.close();
  }
});

test("hub: /events 与 /events/wait", async () => {
  const context = await setup();
  try {
    const empty = await context.get("/events?since=0");
    assert.equal(empty.events.length, 0);
    const waiting = context.get("/events/wait?since=0&timeoutMs=500&types=squad_low_hp");
    await sleep(20);
    context.bridge.mutate((world) => { world.squads[1].members[0].hp = 40; });
    await context.service.pollOnce();
    const waited = await waiting;
    assert.equal(waited.changed, true);
    assert.ok(waited.events.some((event) => event.type === "squad_low_hp"));
    const polled = await context.get("/events?since=0&types=squad_low_hp");
    assert.equal(polled.events.length, 1);
  } finally {
    await context.close();
  }
});
