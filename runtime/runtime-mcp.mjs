import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { actionInput, stopActionInput } from "./exec-service.mjs";
import { runtimeHeaders } from "./token.mjs";
import { dialogueChoiceInput } from "./dialogue.mjs";

const port = Number(process.env.IFZ_RUNTIME_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid IFZ_RUNTIME_PORT.");
const base = `http://127.0.0.1:${port}`;
const server = new McpServer({ name: "ifz-runtime", version: "0.1.0" });

function tool(name, description, inputSchema, request) {
  server.registerTool(name, { description, inputSchema }, async (args, { signal }) => {
    let value;
    try {
      const [path, options] = request(args);
      const response = await fetch(base + path, {
        ...options, headers: runtimeHeaders(options?.headers), redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      });
      value = await response.json();
    } catch (error) {
      value = { ok: false, code: signal.aborted ? "canceled" : "runtime_unreachable", message: error.message };
    }
    return { isError: value.ok === false, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  });
}

const since = z.number().int().nonnegative();
const categories = z.array(z.enum(["squads", "groups", "virtual_groups", "vehicles", "stockpile",
  "events", "stockrooms", "buildings", "worksites", "time", "headquarters", "focused", "dialogue"])).max(13).optional();
const types = z.array(z.string().min(1).max(64)).max(20).optional();
const timeoutMs = z.number().int().min(1).max(10000).optional();
const taskId = z.string().uuid();
function pathWithQuery(path, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value != null) params.set(key, String(value));
  return `${path}?${params}`;
}
tool("runtime_health", "Read live bridge status, the player and AI squad assignment, and DSH scheduling health.", {}, () => ["/health"]);
tool("world_snapshot", "Read the cached state or changes since a version. Select categories to limit output.",
  { since: since.optional(), categories }, (args) => [pathWithQuery("/state", { since: args.since, cats: args.categories })]);
tool("world_wait", "Wait up to 10 seconds for the state version to change.",
  { since, categories, timeoutMs }, (args) => [pathWithQuery("/state/wait", { since: args.since, cats: args.categories, timeoutMs: args.timeoutMs })]);
tool("events_poll", "Read one page of game and action events. Pass the returned cursor as since.",
  { since: since.optional(), types, limit: z.number().int().min(1).max(100).optional() },
  (args) => [pathWithQuery("/events", args)]);
tool("events_wait", "Wait up to 10 seconds for game or action events after a cursor.",
  { since, types, timeoutMs }, (args) => [pathWithQuery("/events/wait", args)]);
tool("get_active_dialogue", "Read the visible radio transcript, currently selectable replies and the game's effect hints. Read again after a choice to see the next conversation.", {}, () => ["/dialogue"]);
tool("choose_dialogue_option", "Choose one currently visible radio reply. Use session_id, choice_id and option_id from get_active_dialogue and a fresh request_id. Reuse request_id on retry.", dialogueChoiceInput,
  (args) => ["/dialogue/choose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }]);
if (process.argv.includes("--enable-actions")) {
  tool("action_submit", "Queue an action for an assigned squad and return a task ID immediately. Reuse requestId on retry. In live co-op, yield after submitting: the scheduler wakes the session on completion. Read action_status to inspect a receipt.",
    actionInput, (args) => ["/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }]);
  tool("action_status", "Read an asynchronous action task and its game receipt.", { taskId }, (args) => [`/actions/${args.taskId}`]);
  tool("action_cancel", "Cancel a queued action or stop it before submission.", { taskId },
    (args) => [`/actions/${args.taskId}`, { method: "DELETE" }]);
  tool("action_force_stop", "Stop a tracked AI action, including a native order already accepted by the game. Provide the reason for the player's notification. Check stopReceipt for any other orders still in the queue before submitting a retreat.",
    { taskId, ...stopActionInput }, ({ taskId, reason }) => [`/actions/${taskId}/stop`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
    }]);
  tool("action_resolve", "Release an unresolved action after checking the outcome. The runtime rechecks that the squad has no active or queued native orders and preserves the unknown result.", { taskId },
    (args) => [`/actions/${args.taskId}/resolve`, { method: "POST" }]);
}

await server.connect(new StdioServerTransport());
