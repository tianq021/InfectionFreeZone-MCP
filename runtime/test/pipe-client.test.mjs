import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { PipeClient } from "../pipe-client.mjs";

test("桥接限制并发，已发送但丢失回执的请求不会重发", async (t) => {
  let active = 0;
  let peak = 0;
  let writes = 0;
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4 || received.length < 4 + received.readUInt32LE(0)) return;
      const { method } = JSON.parse(received.subarray(4));
      if (method === "write") {
        writes++;
        socket.destroy();
        return;
      }
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        const body = Buffer.from(JSON.stringify({ ok: true }));
        const frame = Buffer.alloc(4 + body.length);
        frame.writeUInt32LE(body.length);
        body.copy(frame, 4);
        active--;
        socket.end(frame);
      }, 15);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new PipeClient({ pipePath: { host: "127.0.0.1", port: server.address().port } });
  const replies = await Promise.all(Array.from({ length: 9 }, () => client.call("read")));
  assert.ok(replies.every(({ ok }) => ok));
  assert.equal(peak, 2);
  await assert.rejects(client.call("write"), { code: "bridge_closed" });
  assert.equal(writes, 1);
  assert.equal(client.retries, 0);
});

test("只重试尚未发送数据的连接失败", async () => {
  const client = new PipeClient({ pipePath: "test" });
  let attempts = 0;
  client.exchange = async () => {
    if (++attempts === 1) throw Object.assign(new Error("connect failed"), { code: "bridge_offline", beforeSend: true });
    return { ok: true };
  };
  assert.deepEqual(await client.call("status"), { ok: true });
  assert.equal(attempts, 2);
  assert.equal(client.retries, 1);
  assert.equal(client.failures, 0);
});
