import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";

function claimedMessage(event) {
  const source = event?.data?.source;
  if (event?.type === "user/message" && source?.kind === "user" && typeof source.rpcId === "string")
    return { type: "message_claimed", requestId: source.rpcId };
}

export class DshClient {
  constructor({ home, sessionId, url = "http://127.0.0.1:3080", fetchImpl = fetch, Socket = WebSocket }) {
    const base = new URL(url);
    if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash)
      throw new Error("DSH URL must be a local HTTP origin at 127.0.0.1.");
    this.base = base;
    this.home = home;
    // DSH 的 session/follow 等接口要求 "session-<uuid>" 形式的地址；裸 UUID 会 session/not-found。
    this.sessionId = sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
    this.fetch = fetchImpl;
    this.Socket = Socket;
  }

  async headers() {
    const credentials = await readFile(join(this.home, ".credentials.yaml"), "utf8");
    const secret = credentials.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u)?.[1];
    if (!secret) throw Object.assign(new Error("DSH browser-session authentication is unavailable."), { retryable: false });
    const authority = this.base.host;
    const now = Date.now();
    const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 300000 })).toString("base64url");
    const name = "dsh-auth-" + createHash("sha256").update(authority).digest("base64url");
    const signature = createHmac("sha256", Buffer.from(secret, "base64url")).update(body).digest("base64url");
    return { Cookie: `${name}=v1.${body}.${signature}`, Origin: this.base.origin };
  }

  async rpc(method, request, signal) {
    const headers = await this.headers();
    const deadline = AbortSignal.timeout(5000);
    const response = await this.fetch(new URL(`/api/${method}`, this.base), {
      method: "POST", redirect: "error", headers: { ...headers, "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args: { request } } }),
    });
    if (!response.ok) throw Object.assign(new Error(`DSH HTTP ${response.status}`), {
      code: "dsh_http_error", retryable: response.status >= 500 || response.status === 429,
    });
    const { result } = await response.json();
    if (!result?.ok) throw Object.assign(new Error(result?.error?.message ?? "Invalid DSH RPC reply."), {
      code: result?.error?.code ?? "dsh_rpc_error", retryable: result?.error?.code === "session/agent-busy",
    });
    return result.value;
  }

  async prompt({ text, requestId, mode }, signal) {
    const reply = await this.rpc("session/prompt", {
      sessionId: this.sessionId, requestId, mode,
      content: [{ type: "text", text }], clientTimeZone: "Asia/Shanghai",
    }, signal);
    if (!reply?.accepted) throw new Error("DSH did not confirm prompt acceptance.");
  }

  cancel(signal) {
    return this.rpc("session/cancel", { sessionId: this.sessionId }, signal);
  }

  async follow(onFrame, signal) {
    const headers = await this.headers();
    signal.throwIfAborted();
    const url = new URL("/api/remote.mux", this.base);
    url.protocol = "ws:";
    const streamId = randomUUID();
    return new Promise((resolve, reject) => {
      const socket = new this.Socket(url, { headers, handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
      const firstFrame = setTimeout(() => finish(new Error("DSH follow did not send a snapshot.")), 7000);
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(firstFrame);
        signal.removeEventListener("abort", abort);
        socket.close();
        if (error) reject(error);
        else resolve();
      }
      const abort = () => finish();
      signal.addEventListener("abort", abort, { once: true });
      socket.on("open", () => socket.send(JSON.stringify({
        type: "open", streamId, endpoint: "session/follow",
        payload: { args: { request: { address: { kind: "session", sessionId: this.sessionId }, assistantStream: true, maxMessages: 2 } } },
      })));
      socket.on("message", (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (message.streamId !== streamId) return;
          if (message.type === "error") return finish(Object.assign(new Error(message.error?.message ?? "DSH follow failed."),
            { code: message.error?.code }));
          if (message.type === "end") return finish();
          const frame = message.value;
          if (message.type !== "item" || !frame) return;
          if (frame.type === "snapshot") {
            clearTimeout(firstFrame);
            onFrame({ type: "connected" });
            for (const record of frame.records ?? []) {
              const claimed = claimedMessage(record.event);
              if (claimed) onFrame(claimed);
            }
          } else if (frame.type === "assistant-stream") {
            onFrame({ type: "assistant", frame: frame.frame });
          } else if (frame.type === "event") {
            const claimed = claimedMessage(frame.event);
            if (claimed) onFrame(claimed);
            else if (["turn/start", "turn/end"].includes(frame.event?.type)) onFrame({ type: frame.event.type });
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("close", () => finish());
    });
  }
}
