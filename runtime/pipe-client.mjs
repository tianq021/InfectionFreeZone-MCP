// Minimal client for the IFZ plugin's named-pipe framing protocol.
// One connection per call, matching plugin/PipeBridge.cs (each worker serves one request).
import net from "node:net";

export const PIPE_NAMES = {
  test: "\\\\.\\pipe\\infection-free-zone-mcp-v1",
  steam: "\\\\.\\pipe\\infection-free-zone-mcp-steam-v1",
};

const offlineCodes = new Set(["ENOENT", "ECONNREFUSED"]);

export class PipeClient {
  constructor({ pipePath, timeoutMs = 5000, maxResponseSize = 4 * 1024 * 1024 } = {}) {
    if (!pipePath) throw new Error("PipeClient needs a pipePath.");
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
    this.maxResponseSize = maxResponseSize;
    this.calls = 0;
    this.failures = 0;
  }

  /** @returns {Promise<object>} raw bridge reply (may contain ok:false) */
  async call(method, args = {}) {
    this.calls += 1;
    const body = Buffer.from(JSON.stringify({ method, args }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    const socket = net.createConnection(this.pipePath);
    const chunks = [];
    let expected;
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error("Pipe response timed out"), { code: "pipe_timeout" })), this.timeoutMs);
    try {
      const reply = await new Promise((resolve, reject) => {
        socket.on("connect", () => socket.write(Buffer.concat([header, body])));
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
          if (offlineCodes.has(error.code)) error.code = "bridge_offline";
          reject(error);
        });
        socket.on("close", () => reject(Object.assign(new Error("Bridge closed before replying"), { code: "bridge_closed" })));
      });
      if (reply?.ok === false) this.failures += 1;
      return reply;
    } catch (error) {
      this.failures += 1;
      throw error;
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
}

export function createPipeClient({ steam = false, ...options } = {}) {
  return new PipeClient({ pipePath: steam ? PIPE_NAMES.steam : PIPE_NAMES.test, ...options });
}
