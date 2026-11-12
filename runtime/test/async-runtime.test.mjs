import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { ExecService } from "../exec-service.mjs";
import { StateService } from "../state-service.mjs";
import { createHub } from "../hub.mjs";
import { Scheduler } from "../scheduler.mjs";
import { registerEnemyTools } from "../../tools-extra3.mjs";
import { compass } from "../../tools-extra.mjs";
import { FakeBridge } from "./fake-bridge.mjs";

const token = randomBytes(32).toString("hex");

test("地图方位沿世界坐标 X 向东、Z 向北", () => {
  const offsets = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
  assert.deepEqual(offsets.map(([dx, dz]) => compass(dx, dz)), ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]);
});

async function until(read, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(15);
  }
  assert.fail("Condition did not become true.");
}

function action(sessionId, overrides = {}) {
  return { requestId: randomUUID(), sessionId, squadId: "835", command: "move_squad",
    params: { x: 1350, z: 1474 }, notice: "向东移动", ...overrides };
}

class ActionBridge extends FakeBridge {
  writes = [];
  orders = new Map();
  stops = new Map();
  loseNextStopReply = false;
  losePauseReply = false;
  playerPausesFirst = false;

  async call(method, args) {
    if (["status", "get_state", "get_world_data"].includes(method)) return super.call(method, args);
    if (method === "get_building_info") {
      const building = this.world.buildings.find(({ id }) => id === args.building_id);
      return { ok: Boolean(building), ...building };
    }
    this.writes.push({ method, args });
    switch (method) {
      case "acquire_control": return { ok: true, lease: randomUUID() };
      case "release_control":
      case "hud_message": return { ok: true };
      case "pause": {
        Object.assign(this.baseState.time, { paused: true, gameplay_pause: true });
        if (this.playerPausesFirst) return { ok: false, code: "game_blocked" };
        this.baseState.pause_request_id = args.pause_request_id;
        if (this.losePauseReply)
          throw Object.assign(new Error("pause reply lost"), { code: "pipe_timeout" });
        return this.getState();
      }
      case "advance": {
        Object.assign(this.baseState.time, { paused: false, gameplay_pause: false });
        this.baseState.pause_request_id = null;
        return this.getState();
      }
      case "move_squad":
        this.orders.set(args.request_id, { order_id: args.request_id, state: "moving", terminal: false });
        return { ok: true, order_id: args.request_id, state: "accepted", terminal: false };
      case "get_order": return { ok: true, ...this.orders.get(args.order_id) };
      case "cancel_squad_order": {
        if (this.stops.has(args.request_id)) return this.stops.get(args.request_id);
        const order = this.orders.get(args.order_id);
        if (!order || order.terminal) return { ok: false, code: "order_not_active" };
        Object.assign(order, { state: "canceled", terminal: true });
        const result = { ok: true, order_id: args.order_id, state: "canceled", queued_orders: [] };
        this.stops.set(args.request_id, result);
        if (this.loseNextStopReply) {
          this.loseNextStopReply = false;
          throw Object.assign(new Error("reply lost"), { code: "pipe_timeout" });
        }
        return result;
      }
      default: throw new Error(`Unexpected bridge method ${method}`);
    }
  }
}

async function setupExecutor(t, execute, watchMs) {
  const sessionId = randomUUID();
  const bridge = new ActionBridge({ sessionId });
  bridge.world.squads.find(({ id }) => id === "835").active_order = null;
  const service = new StateService({ pipe: bridge });
  await service.pollOnce();
  const executor = new ExecService({ pipe: bridge, stateService: service, sessionId,
    playerSquadId: "834", squadIds: ["835", "836"], execute, watchMs });
  t.after(async () => { await executor.stop(); service.stop(); });
  return { sessionId, bridge, service, executor };
}

test("协作暂停回执丢失后只恢复该请求拥有的暂停", async (t) => {
  const { sessionId, bridge, executor } = await setupExecutor(t);
  bridge.losePauseReply = true;
  const input = action(sessionId);
  executor.submit(input);
  const task = await until(() => executor.get(input.requestId), ({ state }) => state === "failed");
  assert.equal(task.error.code, "pipe_timeout");
  assert.equal(bridge.baseState.time.paused, false);
  const pauseId = bridge.writes.find(({ method }) => method === "pause").args.pause_request_id;
  assert.equal(bridge.writes.find(({ method }) => method === "advance").args.pause_request_id, pauseId);
  assert.ok(!bridge.writes.some(({ method }) => method === "move_squad"));
});

test("玩家先手动暂停时协作订单不恢复游戏速度", async (t) => {
  const { sessionId, bridge, executor } = await setupExecutor(t);
  bridge.playerPausesFirst = true;
  const input = action(sessionId);
  executor.submit(input);
  const task = await until(() => executor.get(input.requestId), ({ state }) => state === "failed");
  assert.equal(task.error.code, "game_blocked");
  assert.equal(bridge.baseState.time.paused, true);
  assert.ok(!bridge.writes.some(({ method }) => method === "advance" || method === "move_squad"));
});

test("异步 MCP 提交立即返回，复用原生请求 ID，确认到达后发布完成事件", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t);
  const hub = createHub({ stateService: service, executor, port: 0, token });
  const port = await hub.listen();
  t.after(() => hub.close());
  const client = new Client({ name: "async-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../runtime-mcp.mjs", import.meta.url)), "--enable-actions"],
    env: { IFZ_RUNTIME_PORT: String(port), IFZ_RUNTIME_TOKEN: token },
  }));
  const health = await client.callTool({ name: "runtime_health", arguments: {} });
  assert.deepEqual(health.structuredContent.assignment, {
    sessionId, playerSquadId: "834", squadIds: ["835", "836"], pendingVerification: [], ready: true,
  });
  const input = action(sessionId);
  const submit = await client.callTool({ name: "action_submit", arguments: input });
  assert.equal(submit.structuredContent?.task.state, "queued");
  assert.equal(submit.structuredContent.task.taskId, input.requestId);
  const duplicate = await client.callTool({ name: "action_submit", arguments: input });
  assert.equal(duplicate.structuredContent.task.taskId, input.requestId);
  assert.throws(() => executor.submit({ ...input, notice: "不同订单" }), { code: "request_conflict" });
  assert.throws(() => executor.submit(action(sessionId, { squadId: "834" })), { code: "squad_not_assigned" });
  await until(() => executor.get(input.requestId), ({ state }) => state === "watching");
  assert.deepEqual(bridge.writes.filter(({ method }) => method !== "get_order").map(({ method }) => method),
    ["acquire_control", "hud_message", "pause", "move_squad", "advance", "release_control"]);
  assert.equal(bridge.writes.find(({ method }) => method === "move_squad").args.request_id, input.requestId);
  bridge.orders.set(input.requestId, { order_id: input.requestId, state: "arrived", terminal: true });
  await service.pollOnce();
  const finished = await until(() => executor.get(input.requestId), ({ state }) => state === "succeeded");
  assert.equal(finished.order.state, "arrived");
  const events = await client.callTool({ name: "events_poll", arguments: { types: ["action_finished"] } });
  assert.equal(events.structuredContent.events[0].data.taskId, input.requestId);

  bridge.world.squads = bridge.world.squads.filter(({ id }) => id !== "836");
  await service.pollOnce();
  assert.throws(() => executor.submit(action(sessionId)), { code: "squad_changed" });
});

test("DSH 分工验证通过后唤醒一次，插话后后台订单继续回报", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t);
  const prompts = [];
  let interrupts = 0;
  const dsh = {
    sessionId: "dsh",
    async follow(_onFrame, signal) { await once(signal, "abort"); },
    async prompt({ text }) { prompts.push(text); },
    async cancel() { interrupts++; },
  };
  const roster = bridge.world.squads;
  bridge.world.squads = roster.filter(({ id }) => id !== "836");
  await service.pollOnce();
  const scheduler = new Scheduler({ stateService: service, dsh, gameSessionId: sessionId,
    getAssignment: () => executor.assignment(), ordinaryMs: 15 });
  scheduler.start();
  t.after(() => scheduler.stop());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, []);

  bridge.world.squads = roster;
  await service.pollOnce();
  await service.pollOnce();
  await until(() => prompts[0], Boolean);
  assert.match(prompts[0], /玩家保留小队 834，你负责小队 835、836/);

  const input = action(sessionId);
  executor.submit(input);
  await scheduler.sendUserMessage({ requestId: randomUUID(), text: "先回报一下", interrupt: true });
  assert.equal(interrupts, 1);
  assert.equal(prompts[1], "先回报一下");
  await until(() => executor.get(input.requestId), ({ state }) => state === "watching");
  bridge.orders.set(input.requestId, { order_id: input.requestId, state: "arrived", terminal: true });
  await service.pollOnce();
  await until(() => prompts[2], Boolean);
  assert.match(prompts[2], /action_finished/);
  assert.equal(prompts.filter((prompt) => prompt.includes("分工已就绪")).length, 1);
});

test("DSH 直读模式保留查询工具并隐藏写入工具", async (t) => {
  const client = new Client({ name: "direct-read-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../../server.mjs", import.meta.url)), "--steam", "--read-only"],
  }));
  const { tools } = await client.listTools();
  const names = new Set(tools.map(({ name }) => name));
  for (const name of [
    "get_map_buildings", "get_navigation_point", "get_order", "get_state",
    "get_world_data", "status", "get_weather", "get_current_weather", "get_mood", "observe", "get_mission_plan", "get_active_dialogue",
    "get_squad_experience", "get_weapon_details", "get_attack_conditions", "get_workforce", "get_fog_of_war",
    "get_construction_catalog", "preview_construction", "get_construction_order", "get_facilities",
  ]) {
    assert.ok(names.has(name), `Missing read tool: ${name}`);
  }
  for (const name of [
    "acquire_control", "release_control", "pause", "advance", "hud_message",
    "move_squad", "move_npc_group", "attack_group", "scavenge_building",
    "return_to_stockroom", "take_vehicle", "set_stockpile_amount", "set_building_workers", "update_work_task", "queue_construction",
    "set_facility_production", "set_facility_defense_weapon",
    "equip_squad_member", "refill_squad_member_ammo", "export_snapshot", "choose_dialogue_option", "cancel_squad_order",
  ]) {
    assert.ok(!names.has(name), `Unexpected write tool: ${name}`);
  }
  assert.ok(tools.every(({ name }) => !name.startsWith("cheat_")));
  for (const [name, filter] of [["get_squad_experience", "squad_id"], ["get_weapon_details", "weapon_id"]]) {
    const schema = tools.find((tool) => tool.name === name).inputSchema;
    assert.deepEqual(schema.required, ["session_id"]);
    assert.equal(schema.properties[filter].type, "string");
  }
  const conditions = tools.find(({ name }) => name === "get_attack_conditions").inputSchema;
  assert.deepEqual(conditions.required, ["session_id", "squad_id", "group_id"]);
});

test("平民 MCP 可派工和建造，保留敌情与迷雾查询并隐藏小队指令", async (t) => {
  const direct = new Client({ name: "workforce-test", version: "1.0.0" });
  t.after(() => direct.close());
  await direct.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../server.mjs", import.meta.url)), "--workforce-only", "--allow-construction", "--enable-cheats"],
  }));
  const directNames = new Set((await direct.listTools()).tools.map(({ name }) => name));
  for (const name of ["get_workforce", "update_work_task", "acquire_control", "release_control", "get_enemy_report", "get_fog_of_war",
    "get_current_weather", "get_mood",
    "get_construction_catalog", "preview_construction", "queue_construction", "get_construction_order", "get_facilities",
    "set_facility_production", "set_facility_defense_weapon"])
    assert.ok(directNames.has(name), `Missing workforce tool: ${name}`);
  for (const name of ["move_squad", "attack_group", "cancel_squad_order", "scavenge_building", "equip_squad_member", "set_building_workers"])
    assert.ok(!directNames.has(name), `Unexpected tool: ${name}`);
  assert.ok([...directNames].every((name) => !name.startsWith("cheat_")));

  const runtime = new Client({ name: "workforce-runtime-test", version: "1.0.0" });
  t.after(() => runtime.close());
  await runtime.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../runtime-mcp.mjs", import.meta.url))],
  }));
  const { tools } = await runtime.listTools();
  assert.ok(tools.some(({ name }) => name === "world_snapshot"));
  assert.ok(tools.every(({ name }) => !name.startsWith("action_")));
});

test("强制终止已提交的订单，回执丢失时复用请求 ID，并发送一次提醒", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t);
  const hub = createHub({ stateService: service, executor, port: 0, token });
  const port = await hub.listen();
  t.after(() => hub.close());
  const client = new Client({ name: "stop-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../runtime-mcp.mjs", import.meta.url)), "--enable-actions"],
    env: { IFZ_RUNTIME_PORT: String(port), IFZ_RUNTIME_TOKEN: token },
  }));
  const input = action(sessionId);
  executor.submit(input);
  await until(() => executor.get(input.requestId), ({ state }) => state === "watching");
  assert.throws(() => executor.cancel(input.requestId), { code: "order_already_submitted" });
  const reason = "敌群逼近，需要撤退";
  const unauthorized = await fetch(`http://127.0.0.1:${port}/actions/${input.requestId}/stop`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
  });
  assert.equal(unauthorized.status, 401);
  bridge.baseState.time.paused = true;
  bridge.loseNextStopReply = true;
  bridge.writes.length = 0;
  const callStop = () => client.callTool({ name: "action_force_stop", arguments: { taskId: input.requestId, reason } });
  const results = await Promise.all([callStop(), callStop()]);
  assert.ok(results.every((result) => result.structuredContent.task.state === "canceled"));
  const stops = bridge.writes.filter(({ method }) => method === "cancel_squad_order");
  assert.equal(stops.length, 2);
  assert.equal(stops[0].args.request_id, stops[1].args.request_id);
  assert.equal(stops[0].args.order_id, input.requestId);
  assert.equal(bridge.writes.filter(({ method }) => method === "hud_message").length, 1);
  assert.ok(!bridge.writes.some(({ method }) => method === "pause" || method === "advance"));
  assert.equal(bridge.baseState.time.paused, true);
  const { events } = service.getEvents({ types: ["action_finished"] });
  assert.deepEqual(events.map(({ data }) => [data.state, data.reason]), [["canceled", reason]]);
});

test("已被玩家替换的原生订单不会返回取消成功或发送提醒", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t);
  const input = action(sessionId);
  executor.submit(input);
  await until(() => executor.get(input.requestId), ({ state }) => state === "watching");
  bridge.orders.delete(input.requestId);
  const squad = bridge.world.squads.find(({ id }) => id === input.squadId);
  squad.active_order = "MoveToClickableOrder";
  bridge.writes.length = 0;
  await assert.rejects(executor.forceStop(input.requestId, { reason: "撤退" }), { code: "order_not_active" });
  assert.equal(squad.active_order, "MoveToClickableOrder");
  assert.equal(service.getEvents({ types: ["action_finished"] }).events.length, 0);
  assert.ok(!bridge.writes.some(({ method }) => method === "hud_message"));
});

test("战力评估读取真实队员和开火条件，拒绝已脱离视野的敌群", async () => {
  const bridge = new FakeBridge();
  const member = bridge.world.squads[1].members[0];
  bridge.world.squads[1].members = [{ ...member, hp: 90, max_hp: 120 }];
  let estimate;
  let conditionCalls = 0;
  registerEnemyTools({
    registerLocal: (name, _description, _schema, handler) => { if (name === "get_combat_estimate") estimate = handler; },
    request: (method, args) => {
      if (method === "get_state") return { ...bridge.getState(), ok: true };
      if (method !== "get_attack_conditions") return bridge.call(method, args);
      conditionCalls++;
      return { ok: true, mode: "settlement", paused: false,
        members: [{ in_range: true, can_engage_from_position: false, can_attack_now: false }] };
    },
  });
  const args = { squad_ids: ["835"], group_id: "g1" };
  const result = await estimate(args);
  assert.equal(result.ok, true);
  assert.equal(result.squads.hpRatio, 0.75);
  assert.deepEqual(result.squads.detail[0].attack, { inRange: 1, canEngage: 0, canAttackNow: 0 });
  assert.match(result.advice, /无法交火/);
  bridge.world.groups.find(({ id }) => id === "g1").visible = false;
  assert.equal((await estimate(args)).code, "invalid_attack_target");
  assert.equal(conditionCalls, 1);
});

test("浮窗消息越过等待中的游戏通知，独立接收读入回执、文本流和订单结果", async (t) => {
  const state = new EventEmitter();
  Object.assign(state, { state: { sessionId: "game" }, ready: true, online: true });
  let releaseAutomatic;
  const automatic = new Promise((resolve) => { releaseAutomatic = resolve; });
  let automaticStarted = false;
  let emitFrame;
  let userPrompt;
  const dsh = {
    sessionId: "dsh",
    async follow(onFrame, signal) {
      emitFrame = onFrame;
      onFrame({ type: "connected" });
      await once(signal, "abort");
    },
    async prompt(job) {
      if (job.priority !== 0) {
        automaticStarted = true;
        await automatic;
      } else userPrompt = job;
    },
  };
  const scheduler = new Scheduler({ stateService: state, dsh, gameSessionId: "game", ordinaryMs: 0 });
  scheduler.start();
  const hub = createHub({ stateService: state, scheduler, port: 0, token });
  const port = await hub.listen();
  const client = spawn(process.execPath, [fileURLToPath(new URL("../chat-client.mjs", import.meta.url)), String(port)],
    { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, IFZ_RUNTIME_TOKEN: token } });
  const closed = once(client, "close");
  const frames = [];
  const lines = createInterface({ input: client.stdout });
  lines.on("line", (line) => frames.push(JSON.parse(line)));
  t.after(async () => {
    client.stdin.end();
    releaseAutomatic();
    await Promise.all([closed, scheduler.stop(), hub.close()]);
  });

  await until(() => frames.find(({ type }) => type === "status"), (frame) => frame?.connected);
  state.emit("event", { type: "mission_updated", severity: "info", cursor: 1, data: {} });
  await until(() => automaticStarted, Boolean);
  const requestId = randomUUID();
  client.stdin.write(JSON.stringify({ requestId, text: "先回报敌情", interrupt: false }) + "\n");
  const accepted = await until(() => frames.find(({ type }) => type === "accepted"), Boolean);
  assert.equal(accepted.requestId, requestId);
  assert.equal(accepted.claimed, false);
  assert.equal(userPrompt.mode, "steer");
  emitFrame({ type: "message_claimed", requestId });
  emitFrame({ type: "assistant", frame: { type: "chunk", chunk: { type: "text-delta", text: "收到" } } });
  state.emit("event", { type: "action_finished", severity: "info", cursor: 2,
    data: { sessionId: "game", squadId: "835", command: "move_squad", state: "succeeded" } });
  await until(() => frames.find(({ type }) => type === "action_finished"), Boolean);
  assert.deepEqual(frames.filter(({ type }) => ["message_claimed", "reply_delta"].includes(type)), [
    { type: "message_claimed", requestId }, { type: "reply_delta", text: "收到" },
  ]);
});

test("浮窗失焦时订单排队，恢复游戏焦点后自动提交", async (t) => {
  let submission;
  const { sessionId, bridge, service, executor } = await setupExecutor(t, async (_call, options) => {
    submission = options;
    return { ok: true, receipt: { ok: true } };
  });
  bridge.baseState.focused = false;
  await service.pollOnce();
  const input = action(sessionId);
  executor.submit(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submission, undefined);
  assert.equal(executor.get(input.requestId).state, "queued");
  bridge.baseState.focused = true;
  await service.pollOnce();
  await until(() => executor.get(input.requestId), ({ state }) => state === "succeeded");
  assert.equal(submission.noticeLeadMs, 0);
});

test("取消排队任务与未知回执都不会导致重复下单", async (t) => {
  let calls = 0;
  const { sessionId, executor, bridge } = await setupExecutor(t, async (_call, { onSubmit }) => {
    calls++;
    onSubmit();
    return { errors: [{ code: "pipe_timeout", message: "Lost order reply" }] };
  });
  const canceled = action(sessionId);
  executor.submit(canceled);
  assert.equal(executor.cancel(canceled.requestId).state, "canceled");
  const lost = action(sessionId);
  executor.submit(lost);
  await until(() => executor.get(lost.requestId), ({ state }) => state === "unknown");
  assert.equal(executor.submit(lost).held, true);
  assert.throws(() => executor.submit(action(sessionId)), { code: "action_busy" });
  assert.equal(executor.assignment().pendingVerification[0].taskId, lost.requestId);
  assert.equal(calls, 1);
  const squad = bridge.world.squads.find(({ id }) => id === "835");
  const hub = createHub({ stateService: executor.stateService, executor, port: 0, token });
  const port = await hub.listen();
  t.after(() => hub.close());
  const client = new Client({ name: "resolve-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../runtime-mcp.mjs", import.meta.url)), "--enable-actions"],
    env: { IFZ_RUNTIME_PORT: String(port), IFZ_RUNTIME_TOKEN: token },
  }));
  const resolve = async () => (await client.callTool({
    name: "action_resolve", arguments: { taskId: lost.requestId },
  })).structuredContent;
  squad.active_order = "MoveOrder";
  assert.equal((await resolve()).code, "squad_busy");
  squad.active_order = null;
  assert.equal((await resolve()).task.held, false);
  assert.equal(executor.submit(lost).finishedAt > 0, true);
});

test("待确认任务保留小队占用，其他小队仍可接单", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t, async (_call, { onSubmit }) => {
    onSubmit();
    return { errors: [{ code: "pipe_timeout", message: "Lost order reply" }] };
  });
  const ids = Array.from({ length: 64 }, (_, i) => String(1000 + i));
  for (const id of ids) {
    executor.squads.add(id);
    bridge.world.squads.push({ ...bridge.world.squads[1], id });
  }
  await service.pollOnce();
  for (const squadId of ids) {
    const pending = once(service, "event");
    executor.submit(action(sessionId, { squadId }));
    const [event] = await pending;
    assert.equal(event.type, "action_verify_required");
  }
  assert.equal(executor.assignment().pendingVerification.length, 64);
  assert.throws(() => executor.submit(action(sessionId, { squadId: ids[0] })), { code: "action_busy" });
  assert.equal(executor.submit(action(sessionId)).state, "queued");
});

test("无线电接管暂停时拒绝新订单，准备中的订单也不会恢复时间", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t);
  bridge.baseState.dialogue = { choice_id: randomUUID() };
  await service.pollOnce();
  assert.throws(() => executor.submit(action(sessionId)), { code: "dialogue_choice_pending" });
  bridge.baseState.dialogue = null;
  await service.pollOnce();
  const call = bridge.call.bind(bridge);
  bridge.call = (method, args) => {
    if (method === "pause") bridge.baseState.radio_paused = true;
    return call(method, args);
  };
  const input = action(sessionId);
  executor.submit(input);
  const finished = await until(() => executor.get(input.requestId), ({ state }) => state === "failed");
  assert.equal(finished.error.code, "dialogue_choice_pending");
  assert.equal(bridge.baseState.time.paused, true);
  assert.ok(!bridge.writes.some(({ method }) => method === "move_squad" || method === "advance"));
});

test("长期运行可完成 5000 条动作和 2000 条消息，并回放最近的请求", async (t) => {
  let submissions = 0;
  const { sessionId, service, executor } = await setupExecutor(t, async () => {
    submissions++;
    return { ok: true, receipt: { ok: true } };
  });
  const first = action(sessionId);
  for (let i = 0; i < 5000; i++) {
    const done = once(service, "event");
    executor.submit(i === 0 ? first : action(sessionId));
    const [event] = await done;
    assert.equal(event.data.state, "succeeded");
  }
  assert.equal(executor.tasks.size, 0);
  assert.equal(executor.submit(first).state, "succeeded");
  assert.equal(submissions, 5000);
  let deliveries = 0;
  const scheduler = new Scheduler({ stateService: service, dsh: { prompt: async () => { deliveries++; } } });
  t.after(() => scheduler.stop());
  const message = { requestId: randomUUID(), text: "第一条" };
  for (let i = 0; i < 2000; i++) {
    await scheduler.sendUserMessage(i === 0 ? message : { requestId: randomUUID(), text: String(i) });
  }
  assert.equal((await scheduler.sendUserMessage(message)).accepted, true);
  assert.equal(deliveries, 2000);
});

test("移动超时后继续核对原生回执，确认到达后释放小队", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t, undefined, 15);
  const input = action(sessionId);
  executor.submit(input);
  const pending = await until(() => executor.get(input.requestId), ({ state }) => state === "unknown");
  assert.equal(pending.held, true);
  assert.throws(() => executor.submit(action(sessionId)), { code: "action_busy" });
  bridge.orders.set(input.requestId, { order_id: input.requestId, state: "arrived", terminal: true });
  await service.pollOnce();
  const done = await until(() => executor.get(input.requestId), ({ state }) => state === "succeeded");
  assert.equal(done.held, false);
  assert.equal(executor.assignment().pendingVerification.length, 0);
  assert.equal(bridge.writes.filter(({ method }) => method === "move_squad").length, 1);
});

test("搜刮、攻击和回仓以目标状态或卸货变化确认完成", async (t) => {
  let receipt;
  const { sessionId, bridge, service, executor } = await setupExecutor(t, async (_call, options) => {
    await options.validate(bridge.getState(), bridge.world.squads[1]);
    options.onSubmit();
    return { ok: true, receipt: { state: "accepted", ...receipt } };
  });
  const building = bridge.world.buildings[1];
  const group = bridge.world.groups.find(({ id }) => id === "g1");
  const squad = bridge.world.squads[1];
  const stockroom = bridge.world.stockrooms[0];
  const cases = [
    { command: "scavenge_building", params: { building_id: building.id },
      receipt: { order: "MoveToBuildingOrder" }, change: () => { building.scavenged = true; },
      evidence: { buildingId: building.id, scavenged: true } },
    { command: "attack_group", params: { group_id: group.id },
      receipt: { order: "AttackGroupOrder" }, change: () => { group.member_count--; },
      evidence: { groupId: group.id, before: 8, remaining: 7 } },
    { command: "return_to_stockroom", params: { stockroom_id: stockroom.id },
      receipt: { order: "MoveToBuildingOrder", stockroom_id: stockroom.id, mounted: false },
      change: () => { squad.cargo = {}; squad.position = stockroom.position; },
      evidence: { stockroomId: stockroom.id, distance: 0, cargoBefore: 3, cargo: 0 } },
  ];
  squad.cargo = { res_cans: 3 };
  for (const entry of cases) {
    receipt = entry.receipt;
    const input = action(sessionId, { command: entry.command, params: entry.params });
    executor.submit(input);
    await until(() => executor.get(input.requestId), ({ state }) => state === "watching");
    entry.change();
    await service.pollOnce();
    const done = await until(() => executor.get(input.requestId), ({ state }) => state === "succeeded");
    assert.deepEqual(done.evidence, entry.evidence);
  }
});

test("实体和虚拟敌群从原生名册移除时确认攻击完成，脱离视野不算移除", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t, async (_call, options) => {
    await options.validate(bridge.getState(), bridge.world.squads[1]);
    options.onSubmit();
    return { ok: true, receipt: { state: "accepted", order: "AttackGroupOrder" } };
  });
  const target = bridge.world.groups.find(({ id }) => id === "g1");
  bridge.world.virtualGroups = [{ ...target, id: "vg1" }];
  for (const [collection, groupId, virtual] of [["groups", "g1", false], ["virtualGroups", "vg1", true]]) {
    const input = action(sessionId, { command: "attack_group", params: { group_id: groupId, virtual } });
    executor.submit(input);
    await until(() => executor.get(input.requestId), ({ state }) => state === "watching");
    bridge.world[collection].find(({ id }) => id === groupId).visible = false;
    await service.pollOnce();
    assert.equal(executor.get(input.requestId).state, "watching");
    service.state = { ...service.state, [collection]: [] };
    await executor.inspect();
    assert.equal(executor.get(input.requestId).state, "watching");
    bridge.world[collection] = bridge.world[collection].filter(({ id }) => id !== groupId);
    await service.pollOnce();
    const done = await until(() => executor.get(input.requestId), ({ state }) => state === "succeeded");
    assert.deepEqual(done.evidence, { groupId, before: 8, remaining: 0, targetRemoved: true });
    assert.equal(done.held, false);
  }
});

test("搜刮途中保留占用，订单结束后把取得的物资记录为部分完成", async (t) => {
  const { sessionId, bridge, service, executor } = await setupExecutor(t, async (_call, options) => {
    await options.validate(bridge.getState(), bridge.world.squads[1]);
    options.onSubmit();
    return { ok: true, receipt: { state: "accepted", order: "MoveToBuildingOrder" },
      after: { squad: { order: "MoveToBuildingOrder" } } };
  });
  const building = bridge.world.buildings[1];
  building.scavenge = { done: false, remaining_quantity: 8 };
  const squad = bridge.world.squads[1];
  const input = action(sessionId, { command: "scavenge_building", params: { building_id: building.id } });
  executor.submit(input);
  await until(() => executor.get(input.requestId), ({ state }) => state === "watching");
  squad.active_order = "MoveToBuildingOrder";
  squad.cargo = { res_cans: 3 };
  building.scavenge.remaining_quantity = 5;
  await service.pollOnce();
  assert.equal(executor.get(input.requestId).state, "watching");
  squad.active_order = null;
  await service.pollOnce();
  const done = await until(() => executor.get(input.requestId), ({ state }) => state === "succeeded");
  assert.equal(done.evidence.partial, true);
  assert.equal(done.evidence.remaining, 5);
});

test("本地写接口要求令牌并限制突发请求", async (t) => {
  const stateService = { health: () => ({ ready: true }) };
  const executor = { submit: (input) => input, assignment: () => ({ ready: true }) };
  const hub = createHub({ stateService, executor, port: 0, token });
  const port = await hub.listen();
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${port}`;
  const send = (headers = {}) => fetch(base + "/actions", {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
  });
  const anonymous = await send();
  assert.equal(anonymous.status, 401);
  await anonymous.arrayBuffer();
  const headers = { "x-ifz-token": token };
  for (let i = 0; i < 21; i++) {
    const response = await send(headers);
    assert.equal(response.status, i < 20 ? 202 : 429);
    await response.arrayBuffer();
  }
  const health = await fetch(base + "/health");
  assert.equal(health.status, 200);
  assert.ok(!(await health.text()).includes(token));
});

test("DSH 危险唤醒合并，用户消息优先，重试复用请求 ID，助手片段可经 SSE 读到", async (t) => {
  const state = new EventEmitter();
  Object.assign(state, { state: { sessionId: "game" }, ready: true, online: true,
    health: () => ({ ok: true }) });
  const prompts = [];
  const userId = randomUUID();
  let canceled = 0;
  let emitFrame;
  const dsh = {
    sessionId: "dsh",
    async follow(onFrame, signal) {
      emitFrame = onFrame;
      onFrame({ type: "connected" });
      await once(signal, "abort");
    },
    async cancel() { canceled++; },
    async prompt(job) {
      prompts.push({ requestId: job.requestId, mode: job.mode, text: job.text });
      if (job.requestId === userId && prompts.filter(({ requestId }) => requestId === userId).length === 1)
        throw new Error("Temporary RPC failure");
    },
  };
  const scheduler = new Scheduler({ stateService: state, dsh, gameSessionId: "game", dangerMs: 15, ordinaryMs: 40 });
  scheduler.start();
  t.after(() => scheduler.stop());
  const hub = createHub({ stateService: state, scheduler, port: 0, token });
  const port = await hub.listen();
  t.after(() => hub.close());
  const response = await fetch(`http://127.0.0.1:${port}/stream`, { headers: { "x-ifz-token": token } });
  const reader = response.body.getReader();
  t.after(() => reader.cancel());
  const decode = (chunk) => Buffer.from(chunk.value).toString();
  assert.match(decode(await reader.read()), /event: status/);
  emitFrame({ type: "assistant", frame: { text: "收到" } });
  assert.match(decode(await reader.read()), /收到/);

  const message = { requestId: userId, text: "暂停后续操作", interrupt: true };
  const sent = scheduler.sendUserMessage(message);
  assert.equal(sent, scheduler.sendUserMessage(message));
  state.emit("event", { type: "enemy_approach", severity: "critical", cursor: 1, data: {} });
  state.emit("event", { type: "squad_low_hp", severity: "warn", cursor: 2, data: {} });
  assert.equal((await sent).accepted, true);
  assert.equal(canceled, 1);
  assert.equal(prompts[0].requestId, userId);
  assert.equal(prompts[1].mode, "steer");
  assert.match(prompts[1].text, /enemy_approach.*squad_low_hp/);
  assert.equal(prompts[2].requestId, userId);
  state.online = false;
  state.emit("event", { type: "action_finished", severity: "info", cursor: 3, data: { taskId: "test", state: "succeeded" } });
  await until(() => prompts[3], Boolean);
  assert.equal(prompts[3].mode, "queue");
  assert.match(prompts[3].text, /action_finished/);
});

test("事件分页不跳过结果，取消 HTTP 长轮询释放等待者", async (t) => {
  const bridge = new FakeBridge();
  const service = new StateService({ pipe: bridge });
  await service.pollOnce();
  service.pushEvent({ type: "action_finished", data: { taskId: "one" } });
  service.pushEvent({ type: "action_finished", data: { taskId: "two" } });
  const first = service.getEvents({ types: ["action_finished"], limit: 1 });
  assert.equal(first.hasMore, true);
  assert.equal(service.getEvents({ cursor: first.cursor }).events[0].data.taskId, "two");

  const hub = createHub({ stateService: service, port: 0 });
  const port = await hub.listen();
  t.after(() => hub.close());
  const abort = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/state/wait?since=${service.version}&timeoutMs=10000`, { signal: abort.signal });
  const canceled = assert.rejects(pending, { name: "AbortError" });
  await until(() => service.health().stats.waiters, (count) => count === 1);
  abort.abort();
  await canceled;
  await until(() => service.health().stats.waiters, (count) => count === 0);
});
