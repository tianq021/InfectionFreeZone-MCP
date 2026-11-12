import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { executeCoopOrder } from "../coop.mjs";

const id = z.string().trim().min(1).max(64);
const coordinate = z.number().finite();
const params = {
  move_squad: z.strictObject({ x: coordinate, z: coordinate }),
  scavenge_building: z.strictObject({ building_id: id }),
  return_to_stockroom: z.strictObject({ stockroom_id: id.optional(), vehicle_id: id.optional() }),
  attack_group: z.strictObject({ group_id: id, virtual: z.boolean().optional() }),
  take_vehicle: z.strictObject({ vehicle_id: id }),
  equip_squad_member: z.strictObject({ member_id: id, weapon_id: id }),
  refill_squad_member_ammo: z.strictObject({ member_id: id }),
};
export const actionInput = {
  requestId: z.string().uuid(),
  sessionId: z.string().uuid(),
  squadId: id,
  command: z.enum(Object.keys(params)),
  params: z.record(z.string(), z.unknown()).optional(),
  notice: z.string().trim().min(1).max(240),
  priority: z.number().int().min(0).max(10).optional(),
};
const actionSchema = z.strictObject(actionInput);
const transportErrors = new Set(["bridge_offline", "bridge_closed", "bridge_protocol", "pipe_timeout",
  "transport_error", "game_error", "result_unknown", "EPERM", "ECONNRESET", "EPIPE"]);
const terminal = new Set(["succeeded", "failed", "unknown", "canceled"]);
const queueTimeoutMs = 30000;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const summary = (task) => structuredClone(task.view);

export class ExecService {
  constructor({ pipe, stateService, sessionId, playerSquadId, squadIds, execute = executeCoopOrder, watchMs = 120000 }) {
    this.call = async (method, args) => {
      const reply = await pipe.call(method, args);
      if (!reply || reply.ok === false) throw fail(502, reply?.code ?? "bridge_protocol", reply?.message ?? method);
      return reply;
    };
    this.stateService = stateService;
    this.sessionId = sessionId;
    this.playerSquadId = playerSquadId;
    this.squads = new Set(squadIds);
    this.execute = execute;
    this.watchMs = watchMs;
    this.tasks = new Map();
    this.queue = [];
    this.active = null;
    this.stopped = false;
    this.onState = () => {
      void this.inspect();
      void this.drain();
    };
    stateService.on("state", this.onState);
  }

  assignment() {
    const { state, ready, online } = this.stateService;
    const squadIds = [...this.squads];
    const currentIds = new Set(state?.squads.map(({ id }) => String(id)));
    return {
      sessionId: this.sessionId, playerSquadId: this.playerSquadId, squadIds,
      ready: !this.stopped && ready && online && state?.sessionId === this.sessionId &&
        currentIds.has(this.playerSquadId) && squadIds.every((id) => currentIds.has(id)),
    };
  }

  submit(input) {
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) throw fail(400, "invalid_action", parsed.error.issues[0].message);
    const value = parsed.data;
    const commandParams = params[value.command].safeParse(value.params ?? {});
    if (!commandParams.success) throw fail(400, "invalid_action_params", commandParams.error.issues[0].message);
    const action = { ...value, params: commandParams.data, priority: value.priority ?? 0 };
    const previous = this.tasks.get(action.requestId);
    if (previous) {
      if (!isDeepStrictEqual(previous.input, action)) throw fail(409, "request_conflict", "Use a new requestId for a different action.");
      return summary(previous);
    }
    if (this.stopped) throw fail(503, "executor_stopped", "The executor is stopping.");
    if (action.sessionId !== this.sessionId || this.stateService.state?.sessionId !== this.sessionId || !this.stateService.ready || !this.stateService.online)
      throw fail(409, "stale_session", "Read the current game session and confirm the configured squad assignments.");
    if (action.squadId === this.playerSquadId || !this.squads.has(action.squadId))
      throw fail(403, "squad_not_assigned", "The squad is outside the configured AI assignment.");
    if (!this.assignment().ready)
      throw fail(409, "squad_changed", "The squad roster no longer matches the assignment.");
    if (this.tasks.size >= 512 || this.queue.length >= 32) throw fail(429, "action_limit", "The executor queue or history is full.");

    const building = action.params.building_id;
    for (const task of this.tasks.values()) {
      if (!terminal.has(task.view.state) &&
          (task.input.squadId === action.squadId || (building && task.input.params.building_id === building)))
        throw fail(409, "action_busy", "An active task already uses this squad or building.");
    }
    const task = {
      input: action, abort: new AbortController(), timer: null,
      view: { taskId: action.requestId, ...action, state: "queued", createdAt: Date.now() },
    };
    this.tasks.set(action.requestId, task);
    this.queue.push(task);
    this.queue.sort((a, b) => b.input.priority - a.input.priority);
    task.timer = setTimeout(() => {
      this.queue = this.queue.filter((entry) => entry !== task);
      this.finish(task, "failed", { code: "action_expired", message: "The game did not become available before the order expired." });
    }, queueTimeoutMs);
    task.timer.unref();
    setImmediate(() => this.drain());
    return summary(task);
  }

  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw fail(404, "action_not_found", "Unknown task ID.");
    return summary(task);
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) throw fail(404, "action_not_found", "Unknown task ID.");
    if (task.view.state === "queued") {
      this.queue = this.queue.filter((entry) => entry !== task);
      this.finish(task, "canceled");
    } else if (task.view.state === "preparing") {
      task.view.cancelRequested = true;
      task.abort.abort();
    } else if (!terminal.has(task.view.state)) {
      throw fail(409, "order_already_submitted", "The game may already be executing this order.");
    }
    return summary(task);
  }

  finish(task, state, error) {
    if (terminal.has(task.view.state)) return;
    clearTimeout(task.timer);
    Object.assign(task.view, { state, error, finishedAt: Date.now() });
    this.stateService.pushEvent({
      type: "action_finished", severity: state === "unknown" ? "warn" : "info",
      at: task.view.finishedAt,
      data: { taskId: task.view.taskId, sessionId: task.input.sessionId, squadId: task.input.squadId,
        command: task.input.command, state, code: error?.code },
    });
  }

  async drain() {
    if (this.active || this.stopped || !this.queue.length) return;
    const state = this.stateService.state;
    if (state?.sessionId === this.sessionId && (!state.focused || state.time?.paused)) return;
    const task = this.queue.shift();
    clearTimeout(task.timer);
    task.view.state = "preparing";
    const active = this.run(task);
    this.active = active;
    try {
      await active;
    } finally {
      this.active = null;
      if (!this.stopped && this.queue.length) setImmediate(() => this.drain());
    }
  }

  async run(task) {
    const action = task.input;
    try {
      if (Date.now() - task.view.createdAt > queueTimeoutMs)
        throw fail(409, "action_expired", "The queued action is no longer fresh.");
      if (!this.assignment().ready)
        throw fail(409, "assignment_unavailable", "Read the current session and confirm the squad assignment.");
      const result = await this.execute(this.call, {
        session: action.sessionId, player: this.playerSquadId, squadId: action.squadId,
        task: "执行协作订单。", notice: action.notice, command: action.command, owner: "IFZ Runtime",
        stableRequestId: action.requestId, signal: task.abort.signal, noticeLeadMs: 0,
        onSubmit: () => { task.view.state = "submitting"; },
        parameters: (current) => ({
          ...action.params,
          ...(action.command === "return_to_stockroom" && current.vehicle_id && !action.params.vehicle_id
            ? { vehicle_id: current.vehicle_id } : {}),
          ...(action.command === "equip_squad_member" || action.command === "refill_squad_member_ammo" ? { source: "cargo" } : {}),
        }),
        validate: (_state, current) => {
          if (action.command === "attack_group" &&
              current.members?.some((member) => member.hp < 60 || !(member.ammo > 0)))
            throw fail(409, "squad_needs_supplies", "Withdraw or replenish the squad before attacking.");
        },
      });
      task.view.receipt = result.receipt;
      task.view.errors = result.errors;
      const error = result.errors?.[0];
      if (!result.receipt) {
        const submitted = task.view.state === "submitting";
        this.finish(task, submitted && (!error || transportErrors.has(error.code)) ? "unknown" :
          task.abort.signal.aborted && !submitted ? "canceled" : "failed", error);
      } else if (result.receipt.state === "rejected") {
        this.finish(task, "failed", { code: "order_rejected", message: "The game rejected the order." });
      } else if (result.receipt.state === undefined) {
        this.finish(task, result.ok ? "succeeded" : "unknown", error);
      } else {
        task.view.state = "watching";
        task.seenOrder = result.after?.squad?.order === result.receipt.order && Boolean(result.receipt.order);
        task.timer = setTimeout(() => this.finish(task, "unknown", {
          code: "watch_timeout", message: "The order outcome could not be verified in time.",
        }), this.watchMs);
        task.timer.unref();
        this.inspect();
      }
    } catch (error) {
      this.finish(task, task.abort.signal.aborted ? "canceled" : task.view.state === "submitting" ? "unknown" : "failed",
        { code: error.code ?? "action_error", message: error.message });
    }
  }

  async inspect() {
    if (this.inspecting || this.stopped) return;
    this.inspecting = true;
    try {
      const state = this.stateService.state;
      if (!state || !this.stateService.ready || !this.stateService.online) return;
      for (const task of this.tasks.values()) {
        if (task.view.state !== "watching") continue;
        const { input, view } = task;
        if (input.sessionId !== state.sessionId) {
          this.finish(task, "unknown", { code: "session_changed", message: "The settlement changed after submission." });
          continue;
        }
        if (input.command === "move_squad") {
          try {
            const order = await this.call("get_order", { session_id: input.sessionId, order_id: input.requestId });
            if (view.state !== "watching") continue;
            view.order = order;
            if (order.terminal) this.finish(task, order.state === "arrived" ? "succeeded" : "failed",
              order.state === "arrived" ? undefined : { code: order.state, message: "The move ended before arrival." });
          } catch {
            // A read may fail temporarily. The watch deadline bounds recovery.
          }
          continue;
        }
        const squad = state.squads.find(({ id }) => String(id) === input.squadId);
        if (input.command === "take_vehicle" && squad?.vehicle_id === input.params.vehicle_id) {
          this.finish(task, "succeeded");
        } else if (squad?.active_order === view.receipt.order && view.receipt.order) {
          task.seenOrder = true;
        } else if (task.seenOrder || !squad) {
          this.finish(task, "unknown", { code: "order_ended_unverified", message: "The order ended. Read the squad and target to verify the outcome." });
        }
      }
    } finally {
      this.inspecting = false;
    }
  }

  async stop() {
    this.stopped = true;
    this.stateService.off("state", this.onState);
    for (const task of this.queue.splice(0)) this.finish(task, "canceled");
    for (const task of this.tasks.values()) if (task.view.state === "preparing") task.abort.abort();
    await this.active;
    for (const task of this.tasks.values()) if (task.view.state === "watching") this.finish(task, "unknown",
      { code: "executor_stopped", message: "The game may still be executing the order." });
  }
}
