// Local HTTP API for the AI runtime: snapshot/delta reads, long-poll waits, event cursors.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const numberParam = (url, name) => {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};
const listParam = (url, name) => {
  const raw = url.searchParams.get(name);
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : null;
};

function send(response, status, value) {
  if (response.destroyed) return;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    connection: "close",
  });
  response.end(body);
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw Object.assign(new Error("Use application/json."), { status: 415, code: "invalid_content_type" });
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 16384) throw Object.assign(new Error("Request is too large."), { status: 413, code: "request_too_large" });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON."), { status: 400, code: "invalid_json" }); }
}

function stream(response, scheduler) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  const write = (frame) => {
    if (!response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)) response.destroy();
  };
  scheduler.on("stream", write);
  const ping = setInterval(() => {
    if (!response.write(": keepalive\n\n")) response.destroy();
  }, 15000);
  ping.unref();
  response.once("close", () => {
    clearInterval(ping);
    scheduler.off("stream", write);
  });
  write({ type: "status", ...scheduler.health() });
}

export function createHub({ stateService, executor, scheduler, chooseDialogue, host = "127.0.0.1", port = 8790,
  token, requireToken = false, logger = console } = {}) {
  if (!stateService) throw new Error("createHub needs a stateService.");
  if (host !== "127.0.0.1") throw new Error("The runtime HTTP API is local to 127.0.0.1.");
  if ((executor || scheduler || chooseDialogue || requireToken) && !token) throw new Error("The runtime HTTP API needs a token.");
  const expected = token && Buffer.from(token);
  const writes = new Map();
  const server = http.createServer(async (request, response) => {
    try {
      const authority = `${host}:${server.address().port}`;
      const origin = `http://${authority}`;
      if (request.headers.host !== authority || (request.headers.origin && request.headers.origin !== origin))
        return send(response, 403, { ok: false, code: "local_origin_required" });
      const url = new URL(request.url ?? "/", origin);
      const actionId = /^\/actions\/([0-9a-f-]{36})$/i.exec(url.pathname)?.[1];
      const resolveId = /^\/actions\/([0-9a-f-]{36})\/resolve$/i.exec(url.pathname)?.[1];
      const stopId = /^\/actions\/([0-9a-f-]{36})\/stop$/i.exec(url.pathname)?.[1];
      const writeRoute = (request.method === "POST" &&
        (url.pathname === "/actions" || url.pathname === "/messages" || url.pathname === "/dialogue/choose" || resolveId || stopId)) ||
        (request.method === "DELETE" && actionId);
      if (expected && (writeRoute || requireToken || url.pathname === "/stream")) {
        const provided = Buffer.from(request.headers["x-ifz-token"] ?? "");
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
          return send(response, 401, { ok: false, code: "unauthorized" });
      }
      if (writeRoute) {
        const lane = url.pathname === "/messages" ? "messages" : "actions";
        const now = Date.now();
        const recent = (writes.get(lane) ?? []).filter((at) => now - at < 10000);
        if (recent.length >= (lane === "messages" ? 10 : 20))
          return send(response, 429, { ok: false, code: "rate_limited" });
        recent.push(now);
        writes.set(lane, recent);
      }
      if (request.method === "POST" && url.pathname === "/actions") {
        if (!executor) return send(response, 503, { ok: false, code: "executor_disabled" });
        return send(response, 202, { ok: true, task: executor.submit(await readJson(request)) });
      }
      if (request.method === "POST" && resolveId) {
        if (!executor) return send(response, 503, { ok: false, code: "executor_disabled" });
        return send(response, 200, { ok: true, task: await executor.resolve(resolveId) });
      }
      if (request.method === "POST" && stopId) {
        if (!executor) return send(response, 503, { ok: false, code: "executor_disabled" });
        return send(response, 200, { ok: true, task: await executor.forceStop(stopId, await readJson(request)) });
      }
      if (actionId && ["GET", "DELETE"].includes(request.method)) {
        if (!executor) return send(response, 503, { ok: false, code: "executor_disabled" });
        return send(response, 200, { ok: true, task: request.method === "GET" ? executor.get(actionId) : executor.cancel(actionId) });
      }
      if (request.method === "POST" && url.pathname === "/messages") {
        if (!scheduler) return send(response, 503, { ok: false, code: "scheduler_disabled" });
        return send(response, 200, { ok: true, ...await scheduler.sendUserMessage(await readJson(request)) });
      }
      if (request.method === "POST" && url.pathname === "/dialogue/choose") {
        if (!chooseDialogue) return send(response, 503, { ok: false, code: "dialogue_choices_disabled" });
        return send(response, 200, await chooseDialogue(await readJson(request)));
      }
      if (request.method !== "GET") return send(response, 405, { ok: false, code: "method_not_allowed" });
      if (url.pathname === "/stream") {
        if (!scheduler) return send(response, 503, { ok: false, code: "scheduler_disabled" });
        return stream(response, scheduler);
      }

      if (url.pathname === "/") {
        return send(response, 200, {
          ok: true,
          service: "ifz-runtime",
          routes: ["/health", "/state?since=<v>&cats=squads,groups", "/state/wait?since=<v>&timeoutMs=5000",
            "/events?since=<cursor>&types=enemy_approach", "/events/wait?since=<cursor>&timeoutMs=5000",
            ...(executor ? ["/actions", "/actions/<id>", "/actions/<id>/stop"] : []),
            "/dialogue", ...(chooseDialogue ? ["/dialogue/choose"] : []),
            ...(scheduler ? ["/messages", "/stream"] : [])],
        });
      }

      if (url.pathname === "/health") return send(response, 200, {
        ...stateService.health(), executorEnabled: Boolean(executor), assignment: executor?.assignment() ?? null,
        dialogueChoicesEnabled: Boolean(chooseDialogue),
        dsh: scheduler?.health() ?? null,
      });

      if (url.pathname === "/dialogue") {
        if (!stateService.online || !stateService.ready || !stateService.state)
          return send(response, 503, { ok: false, code: "game_not_ready" });
        const result = await stateService.bridgeCall("get_active_dialogue", { session_id: stateService.state.sessionId });
        return send(response, result.ok ? 200 : 502, result);
      }

      if (url.pathname === "/state") {
        const since = numberParam(url, "since");
        const categories = listParam(url, "cats");
        const result = stateService.getCurrent({ since, categories });
        if (since != null && result.changed === false) {
          return send(response, 200, { ok: true, changed: false, version: result.version, at: result.at, sessionId: result.sessionId });
        }
        return send(response, 200, result);
      }

      if (url.pathname === "/state/wait") {
        const started = Date.now();
        const since = numberParam(url, "since");
        const timeoutMs = Math.min(Math.max(numberParam(url, "timeoutMs") ?? 5000, 1), 30000);
        const categories = listParam(url, "cats");
        const abort = new AbortController();
        response.once("close", () => abort.abort());
        const result = await stateService.waitForChange({ since, timeoutMs, categories, signal: abort.signal });
        return send(response, 200, { ...result, waitedMs: Date.now() - started, timeoutMs });
      }

      if (url.pathname === "/events") {
        const cursor = numberParam(url, "since") ?? 0;
        const types = listParam(url, "types");
        const limit = Math.min(Math.max(numberParam(url, "limit") ?? 100, 1), 500);
        return send(response, 200, stateService.getEvents({ cursor, types, limit }));
      }

      if (url.pathname === "/events/wait") {
        const started = Date.now();
        const cursor = numberParam(url, "since") ?? 0;
        const timeoutMs = Math.min(Math.max(numberParam(url, "timeoutMs") ?? 5000, 1), 30000);
        const types = listParam(url, "types");
        const abort = new AbortController();
        response.once("close", () => abort.abort());
        const result = await stateService.waitForEvents({ cursor, timeoutMs, types, signal: abort.signal });
        return send(response, 200, { ...result, waitedMs: Date.now() - started, timeoutMs });
      }

      return send(response, 404, { ok: false, code: "not_found", path: url.pathname });
    } catch (error) {
      if (error?.status && !response.headersSent) return send(response, error.status,
        { ok: false, code: error.code, message: error.message });
      logger?.error?.("[hub] " + String(error?.stack ?? error));
      if (!response.headersSent) send(response, 500, { ok: false, code: "hub_error", message: String(error?.message ?? error) });
      else response.destroy();
    }
  });

  return {
    server,
    /** @returns {Promise<number>} bound port (useful for tests with port 0) */
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
