import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { executeCoopOrder, readState, readWorld } from "../coop.mjs";

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
const watchDurations = { move_squad: 90000, scavenge_building: 600000, attack_group: 300000,
  return_to_stockroom: 240000, take_vehicle: 180000 };
const queueTimeoutMs = 30000;
const historyMs = 30 * 60 * 1000;
const historyLimit = 20000;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const summary = (task) => structuredClone(task.view);
const totalCargo = (cargo) => Object.values(cargo ?? {}).reduce((sum, amount) => sum + amount, 0);

export class ExecService {
  constructor({ pipe, stateService, sessionId, playerSquadId, squadIds, execute = executeCoopOrder, watchMs }) {
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
    this.finished = new Map();
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
      pendingVerification: [...this.tasks.values()].filter(({ view }) => view.state === "unknown")
        .map(({ view }) => ({ taskId: view.taskId, squadId: view.squadId, code: view.error?.code })),
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
    const previous = this.lookup(action.requestId);
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
    if (this.tasks.size >= 64 || this.queue.length >= 32) throw fail(429, "action_limit", "The executor has too many active tasks.");

    const building = action.params.building_id;
    for (const task of this.tasks.values()) {
      if (task.input.squadId === action.squadId || (building && task.input.params.building_id === building))
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

  lookup(id) {
    const cutoff = Date.now() - historyMs;
    for (const [taskId, task] of this.finished) {
      if (task.view.finishedAt >= cutoff && this.finished.size <= historyLimit) break;
      this.finished.delete(taskId);
    }
    return this.tasks.get(id) ?? this.finished.get(id);
  }

  get(id) {
    const task = this.lookup(id);
    if (!task) throw fail(404, "action_not_found", "Unknown task ID.");
    return summary(task);
  }

  cancel(id) {
    const task = this.lookup(id);
    if (!task) throw fail(404, "action_not_found", "Unknown task ID.");
    if (task.view.state === "queued") {
      this.queue = this.queue.filter((entry) => entry !== task);
      this.finish(task, "canceled");
    } else if (task.view.state === "preparing") {
      task.view.cancelRequested = true;
      task.abort.abort();
    } else if (!task.view.finishedAt) {
      throw fail(409, "order_already_submitted", "The game may already be executing this order.");
    }
    return summary(task);
  }

  async resolve(id) {
    const task = this.lookup(id);
    if (!task) throw fail(404, "action_not_found", "Unknown task ID.");
    if (task.view.finishedAt) return summary(task);
    if (task.view.state !== "unknown")
      throw fail(409, "action_not_held", "Only an unresolved action can be released.");
    const current = await readState(this.call, task.input.sessionId);
    const squads = await readWorld(this.call, current, "squads");
    const squad = squads.find(({ id }) => String(id) === task.input.squadId);
    if (squad?.active_order || squad?.queued_orders?.length)
      throw fail(409, "squad_busy", "Wait until the squad has no active or queued game orders.");
    this.finish(task, "unknown", { code: "operator_released", message: "The operator released the held action." });
    return summary(task);
  }

  finish(task, state, error) {
    if (task.view.finishedAt) return;
    clearTimeout(task.timer);
    Object.assign(task.view, { state, error, held: false, finishedAt: Date.now() });
    this.tasks.delete(task.input.requestId);
    this.finished.set(task.input.requestId, { input: task.input, view: task.view });
    this.lookup(task.input.requestId);
    this.stateService.pushEvent({
      type: "action_finished", severity: state === "unknown" ? "warn" : "info",
      at: task.view.finishedAt,
      data: { taskId: task.view.taskId, sessionId: task.input.sessionId, squadId: task.input.squadId,
        command: task.input.command, state, code: error?.code },
    });
  }

  hold(task, error) {
    if (task.view.finishedAt || task.view.state === "unknown") return;
    clearTimeout(task.timer);
    Object.assign(task.view, { state: "unknown", error, held: true });
    this.stateService.pushEvent({
      type: "action_verify_required", severity: "warn", at: Date.now(),
      data: { taskId: task.view.taskId, sessionId: task.input.sessionId, squadId: task.input.squadId,
        command: task.input.command, state: "unknown", code: error?.code },
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
        validate: async (paused, current) => {
          if (action.command === "attack_group" &&
              current.members?.some((member) => member.hp < 60 || !(member.ammo > 0)))
            throw fail(409, "squad_needs_supplies", "Withdraw or replenish the squad before attacking.");
          if (action.command === "attack_group") {
            const groups = await readWorld(this.call, paused, action.params.virtual ? "virtual_groups" : "groups");
            task.targetCount = groups.find(({ id }) => String(id) === action.params.group_id)?.member_count;
          }
          if (action.command === "return_to_stockroom") {
            const vehicle = current.vehicle_id && (await readWorld(this.call, paused, "vehicles"))
              .find(({ id }) => String(id) === current.vehicle_id);
            task.cargoBefore = current.vehicle_id
              ? (vehicle?.trunk ? totalCargo(vehicle.trunk.cargo) : undefined)
              : totalCargo(current.cargo);
          }
        },
      });
      task.view.receipt = result.receipt;
      task.view.errors = result.errors;
      const error = result.errors?.[0];
      if (!result.receipt) {
        const submitted = task.view.state === "submitting";
        if (submitted && (!error || transportErrors.has(error.code))) this.hold(task, error);
        else this.finish(task, task.abort.signal.aborted && !submitted ? "canceled" : "failed", error);
      } else if (result.receipt.state === "rejected") {
        this.finish(task, "failed", { code: "order_rejected", message: "The game rejected the order." });
      } else if (result.receipt.state === undefined) {
        this.finish(task, "succeeded");
      } else {
        task.view.state = "watching";
        task.seenOrder = result.after?.squad?.order === result.receipt.order && Boolean(result.receipt.order);
        task.timer = setTimeout(() => this.hold(task, {
          code: "watch_timeout", message: "The order outcome could not be verified in time.",
        }), this.watchMs ?? watchDurations[action.command] ?? 120000);
        task.timer.unref();
        this.inspect();
      }
    } catch (error) {
      const detail = { code: error.code ?? "action_error", message: error.message };
      if (task.view.state === "submitting") this.hold(task, detail);
      else this.finish(task, task.abort.signal.aborted ? "canceled" : "failed", detail);
    }
  }

  async inspect() {
    if (this.inspecting || this.stopped) return;
    this.inspecting = true;
    try {
      const state = this.stateService.state;
      if (!state || !this.stateService.ready || !this.stateService.online) return;
      for (const task of this.tasks.values()) {
        if (task.view.state !== "watching" && task.view.state !== "unknown") continue;
        const { input, view } = task;
        if (input.sessionId !== state.sessionId) {
          this.finish(task, "unknown", { code: "session_changed", message: "The settlement changed after submission." });
          continue;
        }
        if (input.command === "move_squad") {
          try {
            const order = await this.call("get_order", { session_id: input.sessionId, order_id: input.requestId });
            if (view.finishedAt) continue;
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
        } else if (view.receipt?.order && (squad?.active_order === view.receipt.order ||
          squad?.queued_orders?.includes(view.receipt.order))) {
          task.seenOrder = true;
        } else if (!squad) {
          this.finish(task, "failed", { code: "squad_lost", message: "The assigned squad is no longer present." });
        } else if (view.receipt) {
          const evidence = await this.verify(task, state, squad);
          if (evidence && !view.finishedAt && !this.stopped) {
            view.evidence = evidence;
            this.finish(task, "succeeded");
          }
        }
      }
    } finally {
      this.inspecting = false;
    }
  }

  async verify(task, state, squad) {
    const { input, view } = task;
    if (input.command === "scavenge_building") {
      try {
        const building = await this.call("get_building_info", {
          session_id: input.sessionId, building_id: input.params.building_id,
        });
        if (building.scavenged === true && this.stateService.state?.sessionId === input.sessionId)
          return { buildingId: input.params.building_id, scavenged: true };
      } catch {
        // Recheck later if the bridge or target is unavailable.
      }
    }
    if (input.command === "attack_group") {
      const groups = input.params.virtual ? state.virtualGroups : state.groups;
      const target = groups?.find(({ id }) => String(id) === input.params.group_id);
      if (target?.visible && target.member_count < task.targetCount)
        return { groupId: input.params.group_id, before: task.targetCount, remaining: target.member_count };
    }
    if (input.command === "return_to_stockroom") {
      const room = state.stockrooms?.find(({ id }) => String(id) === view.receipt.stockroom_id);
      const vehicle = view.receipt.mounted && state.vehicles?.find(({ id }) => String(id) === view.receipt.vehicle_id);
      const position = view.receipt.mounted ? vehicle?.position : squad.position;
      if (!position || !room?.position) return;
      const distance = Math.hypot(position.x - room.position.x, position.z - room.position.z);
      const cargo = totalCargo(view.receipt.mounted ? vehicle.trunk?.cargo : squad.cargo);
      const unloaded = task.cargoBefore > 0 && cargo < task.cargoBefore && distance <= 40;
      const arrivedEmpty = task.cargoBefore === 0 && task.seenOrder && distance <= 12;
      if (unloaded || arrivedEmpty) return { stockroomId: room.id, distance, cargoBefore: task.cargoBefore, cargo };
    }
  }

  async stop() {
    this.stopped = true;
    this.stateService.off("state", this.onState);
    for (const task of this.queue.splice(0)) this.finish(task, "canceled");
    for (const task of this.tasks.values()) if (task.view.state === "preparing") task.abort.abort();
    await this.active;
    for (const task of this.tasks.values()) if (task.view.state === "watching") this.hold(task,
      { code: "executor_stopped", message: "The game may still be executing the order." });
  }
}
