// Minimal client for the IFZ plugin's named-pipe framing protocol.
// One connection per call, matching plugin/PipeBridge.cs (each worker serves one request).
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export const PIPE_NAMES = {
  test: "\\\\.\\pipe\\infection-free-zone-mcp-v1",
  steam: "\\\\.\\pipe\\infection-free-zone-mcp-steam-v1",
};

const offlineCodes = new Set(["ENOENT", "ECONNREFUSED"]);
const busyCodes = new Set(["EBUSY", "EAGAIN"]);
const connectRetryMs = [40, 100];

export class PipeClient {
  constructor({ pipePath, timeoutMs = 5000, maxResponseSize = 4 * 1024 * 1024, concurrency = 2 } = {}) {
    if (!pipePath) throw new Error("PipeClient needs a pipePath.");
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid pipe concurrency.");
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.maxResponseSize = maxResponseSize;
    this.concurrency = concurrency;
    this.active = 0;
    this.waiting = [];
    this.calls = 0;
    this.failures = 0;
    this.retries = 0;
  }

  /** @returns {Promise<object>} raw bridge reply (may contain ok:false) */
  async call(method, args = {}) {
    this.calls += 1;
    const deadline = performance.now() + this.timeoutMs;
    if (this.active < this.concurrency) this.active += 1;
    else await new Promise((resolve) => this.waiting.push(resolve));
    try {
      const body = Buffer.from(JSON.stringify({ method, args }), "utf8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      const frame = Buffer.concat([header, body]);
      for (let attempt = 0; ; attempt++) {
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          throw Object.assign(new Error("The bridge request expired while waiting to connect."), { code: "bridge_busy" });
        try {
          const reply = await this.exchange(frame, remaining);
          if (reply?.ok === false) this.failures += 1;
          return reply;
        } catch (error) {
          const delay = connectRetryMs[attempt];
          if (!error.beforeSend || delay == null || performance.now() + delay >= deadline) throw error;
          this.retries += 1;
          await sleep(delay);
        }
      }
    } catch (error) {
      this.failures += 1;
      throw error;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  async exchange(frame, timeoutMs) {
    const socket = net.createConnection(this.pipePath);
    const chunks = [];
    let connected = false;
    let expected;
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error("Pipe response timed out"), { code: "pipe_timeout" })), timeoutMs);
    try {
      return await new Promise((resolve, reject) => {
        socket.on("connect", () => {
          connected = true;
          socket.write(frame);
        });
        socket.on("data", (chunk) => {
          chunks.push(chunk);
          const buffered = Buffer.concat(chunks);
          if (buffered.length < 4) return;
          expected ??= buffered.readUInt32LE(0);
          if (!expected || expected > this.maxResponseSize) {
            reject(Object.assign(new Error("Invalid bridge response length"), { code: "bridge_protocol" }));
            return;
          }
          if (buffered.length >= expected + 4) {
            try {
              resolve(JSON.parse(buffered.subarray(4, expected + 4).toString("utf8")));
            } catch (error) {
              reject(Object.assign(new Error("Invalid bridge JSON: " + error.message), { code: "bridge_protocol" }));
            }
          }
        });
        socket.on("error", (error) => {
          if (!connected && (offlineCodes.has(error.code) || busyCodes.has(error.code))) {
            error.beforeSend = true;
            error.code = offlineCodes.has(error.code) ? "bridge_offline" : "bridge_busy";
          }
          reject(error);
        });
        socket.on("close", () => reject(Object.assign(new Error("Bridge closed before replying"), { code: "bridge_closed" })));
      });
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
}

export function createPipeClient({ steam = false, ...options } = {}) {
  return new PipeClient({ pipePath: steam ? PIPE_NAMES.steam : PIPE_NAMES.test, ...options });
}
