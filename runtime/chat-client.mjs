// JSON lines over stdio for the floating chat window. Both HTTP channels use loopback.
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { runtimeHeaders } from "./token.mjs";

const port = Number(process.argv[2] ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid runtime chat port.");
const base = `http://127.0.0.1:${port}`;
const stop = new AbortController();
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const streamedBlocks = new Set();

function forward(frame) {
  if (frame.type !== "assistant") {
    emit(frame);
    return;
  }
  const { type, chunk } = frame.frame;
  if (type === "start" || type === "end") {
    streamedBlocks.clear();
    emit({ type: `reply_${type}` });
  } else if (type === "chunk" && chunk?.type === "text-delta") {
    streamedBlocks.add(chunk.index);
    emit({ type: "reply_delta", text: chunk.text });
  } else if (type === "chunk" && chunk?.type === "block-end" && chunk.block?.type === "text" && !streamedBlocks.has(chunk.index)) {
    emit({ type: "reply_delta", text: chunk.block.text });
  }
}

async function follow() {
  const { signal } = stop;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${base}/stream`, { signal, headers: runtimeHeaders(), redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Runtime stream HTTP ${response.status}`);
      }
      const body = Readable.fromWeb(response.body);
      const lines = createInterface({ input: body, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (line.startsWith("data: ")) forward(JSON.parse(line.slice(6)));
        }
      } finally { body.destroy(); }
    } catch {
      // The sending channel is independent of the stream and has its own deadline.
    }
    if (signal.aborted) return;
    emit({ type: "disconnected" });
    await sleep(1000, undefined, { signal }).catch(() => {});
  }
}

async function send({ requestId, text, interrupt }) {
  try {
    const response = await fetch(`${base}/messages`, {
      method: "POST", headers: runtimeHeaders({ "content-type": "application/json" }), redirect: "error",
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(22000)]),
      body: JSON.stringify({ requestId, text, interrupt }),
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) {
      emit({ type: "send_error", requestId, code: result.code ?? `http_${response.status}` });
      return;
    }
    emit({ type: "accepted", requestId, claimed: result.claimed, interruptError: result.interruptError });
  } catch {
    if (!stop.signal.aborted) emit({ type: "send_error", requestId, code: "delivery_unconfirmed" });
  }
}

const stream = follow();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try { void send(JSON.parse(line)); }
  catch { emit({ type: "send_error", code: "invalid_chat_message" }); }
}
stop.abort();
await stream;
