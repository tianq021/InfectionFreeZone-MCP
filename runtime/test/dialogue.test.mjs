import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDialogueChooser } from "../dialogue.mjs";
import { createHub } from "../hub.mjs";
import { Scheduler } from "../scheduler.mjs";
import { StateService } from "../state-service.mjs";
import { FakeBridge } from "./fake-bridge.mjs";

class RadioBridge extends FakeBridge {
  selection = null;
  writes = 0;
  leasesReleased = 0;

  async call(method, args) {
    switch (method) {
      case "get_active_dialogue":
        return { ok: true, session_id: this.sessionId, dialogue: this.baseState.dialogue, last_choice: this.selection };
      case "acquire_control":
        return { ok: true, lease: (this.lease = randomUUID()) };
      case "release_control":
        assert.equal(args.lease, this.lease);
        this.lease = null;
        this.leasesReleased++;
        return { ok: true };
      case "choose_dialogue_option": {
        assert.equal(args.lease, this.lease);
        assert.equal(args.session_id, this.sessionId);
        if (args.request_id === this.selection?.receipt.request_id) return this.selection.receipt;
        const dialogue = this.baseState.dialogue;
        if (dialogue?.choice_id !== args.choice_id) return { ok: false, code: "stale_dialogue_choice" };
        const option = dialogue.options.find(({ option_id }) => option_id === args.option_id);
        if (!option?.selectable) return { ok: false, code: "invalid_dialogue_option" };
        this.writes++;
        const receipt = { ok: true, state: "selected", request_id: args.request_id, option };
        this.selection = { receipt, ended: true, observed_lines: [{ speaker: "NPC", text: "明天会有人送来补给。" }] };
        this.baseState.dialogue = null;
        return receipt;
      }
      default:
        return super.call(method, args);
    }
  }
}

test("无线电出现可选项时唤醒模型，可读原文和提示、选择并读取后续", async (t) => {
  const sessionId = randomUUID();
  const pipe = new RadioBridge({ sessionId });
  const stateService = new StateService({ pipe });
  const choiceId = randomUUID();
  const option = { option_id: 1, text: "同意交换", selectable: true, ends_call: false,
    effect_hints: [{ keys: ["res_food"], alternatives: false, value: 5, percent: false }] };
  pipe.baseState.dialogue = { transmission_id: "trade_call", choice_id: choiceId,
    text: "能用木材交换食物吗？", options: [option, { option_id: 2, text: "拒绝", selectable: true }] };
  let wake;
  const prompted = new Promise((resolve) => { wake = resolve; });
  const scheduler = new Scheduler({ stateService, gameSessionId: sessionId, dangerMs: 0, dsh: {
    follow: async (_frame, signal) => { await once(signal, "abort"); },
    prompt: async (job) => { wake(job); },
  } });
  scheduler.start();
  t.after(() => scheduler.stop());
  await stateService.pollOnce();
  const prompt = await prompted;
  assert.equal(prompt.mode, "steer");
  assert.match(prompt.text, /get_active_dialogue/);
  await stateService.pollOnce();
  assert.equal(stateService.getEvents({ types: ["dialogue_options_available"] }).events.length, 1);
  const since = stateService.version;
  const token = randomBytes(32).toString("hex");
  const chooseDialogue = createDialogueChooser({ pipe, stateService, gameSessionId: sessionId });
  const hub = createHub({ stateService, chooseDialogue, token, port: 0 });
  const port = await hub.listen();
  t.after(() => hub.close());
  const client = new Client({ name: "radio-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL("../runtime-mcp.mjs", import.meta.url))],
    env: { IFZ_RUNTIME_PORT: String(port), IFZ_RUNTIME_TOKEN: token },
  }));
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent;
  const current = await call("get_active_dialogue");
  assert.equal(current.dialogue.text, "能用木材交换食物吗？");
  assert.deepEqual(current.dialogue.options[0].effect_hints, option.effect_hints);
  const args = { session_id: sessionId, choice_id: choiceId, option_id: 1, request_id: randomUUID() };
  assert.equal((await call("choose_dialogue_option", args)).state, "selected");
  assert.equal((await call("choose_dialogue_option", args)).state, "selected");
  assert.equal((await call("choose_dialogue_option", { ...args, request_id: randomUUID() })).code, "stale_dialogue_choice");
  assert.equal(pipe.writes, 1);
  assert.equal(pipe.leasesReleased, 3);
  const after = await call("get_active_dialogue");
  assert.equal(after.dialogue, null);
  assert.equal(after.last_choice.observed_lines[0].text, "明天会有人送来补给。");
  await stateService.pollOnce();
  assert.equal(stateService.getCurrent({ since, categories: ["dialogue"] }).delta.dialogue, null);
});
