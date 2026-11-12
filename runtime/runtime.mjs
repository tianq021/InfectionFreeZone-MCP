// Runtime entry point: state service, optional action queue and optional DSH scheduling.
// Usage: node runtime/runtime.mjs [--steam] [--port 8790] [--buildings]
import { createPipeClient } from "./pipe-client.mjs";
import { StateService } from "./state-service.mjs";
import { createHub } from "./hub.mjs";
import { ExecService } from "./exec-service.mjs";
import { Scheduler } from "./scheduler.mjs";
import { DshClient } from "./dsh-client.mjs";
import { runtimeToken } from "./token.mjs";
import { createDialogueChooser } from "./dialogue.mjs";
import { z } from "zod";

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
};

const steam = hasFlag("--steam");
const includeBuildings = hasFlag("--buildings");
const port = Number(option("--port", "8790"));
const fastIntervalMs = Number(option("--poll-ms", "500"));
const gameSessionId = option("--game-session");
const playerSquadId = option("--player-squad");
const squadIds = option("--squads")?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
const dshSessionId = option("--dsh-session");
const dshHome = option("--dsh-home", process.env.DSH_HOME);
const enableActions = hasFlag("--enable-actions");
const enableDialogueChoices = enableActions || hasFlag("--enable-dialogue-choices");
const uuid = z.string().uuid();
if (enableActions && (!uuid.safeParse(gameSessionId).success || !playerSquadId || !squadIds.length || squadIds.includes(playerSquadId)))
  throw new Error("--enable-actions requires --game-session UUID, --player-squad ID and --squads ID,ID excluding the player.");
if (dshSessionId && (!uuid.safeParse(dshSessionId).success || !uuid.safeParse(gameSessionId).success || !dshHome))
  throw new Error("--dsh-session requires a DSH session UUID, --game-session UUID and --dsh-home or DSH_HOME.");

const log = (event, detail = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

const pipe = createPipeClient({ steam });
const service = new StateService({
  pipe,
  config: { fastIntervalMs, includeBuildings },
  logger: { error: (message) => log("state_error", { message }) },
});
const executor = enableActions ? new ExecService({ pipe, stateService: service, sessionId: gameSessionId, playerSquadId, squadIds }) : null;
const scheduler = dshSessionId ? new Scheduler({
  stateService: service, gameSessionId,
  dsh: new DshClient({ home: dshHome, sessionId: dshSessionId, url: option("--dsh-url") }),
  getAssignment: executor ? () => executor.assignment() : undefined,
}) : null;
const requireToken = hasFlag("--require-token");
const chooseDialogue = enableDialogueChoices ? createDialogueChooser({ pipe, stateService: service, gameSessionId }) : null;
const token = executor || scheduler || chooseDialogue || requireToken ? runtimeToken({ create: true }) : undefined;
const hub = createHub({ stateService: service, executor, scheduler, chooseDialogue, port, token, requireToken });

service.on("event", (event) => {
  if (["bridge_offline", "bridge_restored", "bridge_error", "session_changed"].includes(event.type)) {
    log("event", { type: event.type, severity: event.severity, cursor: event.cursor, code: event.data?.code });
  }
});

const boundPort = await hub.listen();
scheduler?.start();
await service.start();
log("runtime_started", {
  url: `http://127.0.0.1:${boundPort}`,
  steam,
  includeBuildings,
  executorEnabled: Boolean(executor),
  dshEnabled: Boolean(scheduler),
  fastIntervalMs,
  health: service.health(),
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  log("runtime_stopping");
  service.stop();
  await Promise.allSettled([scheduler?.stop(), executor?.stop(), hub.close()]);
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
