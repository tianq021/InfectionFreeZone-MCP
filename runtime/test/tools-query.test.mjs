import test from "node:test";
import assert from "node:assert/strict";
import { createQuery, distance } from "../../tools-query.mjs";

const state = { ok: true, ready: true, session_id: "s1" };
test("query follows every page using one session", async () => {
  const calls = [];
  const q = await createQuery(async (method, args) => {
    calls.push([method, args]);
    if (method === "get_state") return state;
    return { ok: true, session_id: "s1", items: [args.offset], next_offset: args.offset === 0 ? 100 : null };
  });
  assert.deepEqual(await q.world("citizens"), [0, 100]);
  assert.equal(calls[2][1].session_id, "s1");
});
test("query rejects unavailable state and preserves bridge errors", async () => {
  await assert.rejects(createQuery(async () => ({ ok: true, ready: false })), { code: "session_not_ready" });
  await assert.rejects(createQuery(async () => ({ ok: false, code: "bridge_offline" })), { code: "bridge_offline" });
  for (const session_id of [5, {}, " "]) {
    await assert.rejects(createQuery(async () => ({ ...state, session_id })), { code: "session_not_ready" });
  }
});
test("query refuses invalid cursors, changed sessions and truncated scans", async () => {
  for (const [reply, code] of [
    [{ items: [1], next_offset: 0 }, "invalid_page"],
    [{ items: [], next_offset: 100 }, "invalid_page"],
    [{ items: [1], session_id: "s2" }, "session_changed"],
    [{ items: [1], next_offset: 100 }, "query_limit"],
    [{}, "invalid_page"],
    [{ ok: false, code: "world_unavailable" }, "world_unavailable"],
  ]) {
    const q = await createQuery(async m => m === "get_state" ? state : { ok: true, ...reply }, { maxPages: 1 });
    await assert.rejects(q.world("groups"), { code });
  }
});
test("distance never substitutes origin for missing coordinates", () => {
  assert.equal(distance(null, { x: 0, z: 0 }), null);
  assert.equal(distance({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
});
