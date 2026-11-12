import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerCheatTools } from "../../cheat-tools.mjs";

test("作弊目录按类别展开，执行时验证参数并返回简明结果", async () => {
  const handlers = new Map();
  const calls = [];
  const lease = randomUUID();
  const session_id = randomUUID();
  const request_id = randomUUID();
  registerCheatTools({
    registerLocal: (name, _description, _schema, handler) => handlers.set(name, handler),
    request: async (method, args) => {
      calls.push({ method, args });
      if (method === "acquire_control") return { ok: true, lease };
      if (method === "release_control") return { ok: true };
      return { ok: true, healed: 2, wounded: [{ id: "1" }, { id: "2" }] };
    },
  });

  const catalog = handlers.get("cheat_catalog");
  assert.deepEqual(await catalog({}), { ok: true, categories: ["resources", "weapons", "units", "world", "missions"] });
  assert.deepEqual((await catalog({ category: "weapons" })).actions.map(({ action }) => action),
    ["give_weapon", "refill_ammo"]);
  assert.equal((await catalog({ action: "spawn_infected" })).args, "x, z, count?=1");

  const apply = handlers.get("cheat_apply");
  assert.equal((await apply({ action: "spawn_infected", params: { x: 20, z: 20, count: 13 },
    session_id, request_id })).code, "invalid_cheat_params");
  assert.equal(calls.length, 0);
  assert.deepEqual(await apply({ action: "heal_squads", session_id, request_id }),
    { ok: true, healed: 2, wounded_count: 2, action: "heal_squads", request_id });
  assert.deepEqual(calls, [
    { method: "acquire_control", args: { owner: "IFZ MCP cheats" } },
    { method: "cheat_apply", args: { action: "heal_squads", params: {}, session_id, request_id, lease } },
    { method: "release_control", args: { lease } },
  ]);
});
