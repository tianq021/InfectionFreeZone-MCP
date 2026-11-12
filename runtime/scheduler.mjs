import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const userMessage = z.strictObject({
  requestId: z.string().uuid(),
  text: z.string().trim().min(1).max(4000),
  interrupt: z.boolean().default(false),
});
const danger = new Set(["enemy_approach", "squad_low_hp", "squad_threat"]);
const ordinary = new Set(["order_completed", "cargo_full", "low_stock", "nightfall", "mission_updated"]);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const retryDelays = [500, 1500];

export class Scheduler extends EventEmitter {
  constructor({ stateService, dsh, gameSessionId, getAssignment, dangerMs = 300, ordinaryMs = 1500 }) {
    super();
    this.stateService = stateService;
    this.dsh = dsh;
    this.gameSessionId = gameSessionId;
    this.getAssignment = getAssignment;
    this.dangerMs = dangerMs;
    this.ordinaryMs = ordinaryMs;
    this.abort = new AbortController();
    this.events = new Map();
    this.queue = [];
    this.messages = new Map();
    this.retryTimers = new Map();
    this.connected = false;
    this.onGameEvent = (event) => this.onEvent(event);
    this.onAssignmentReady = () => this.announceAssignment();
  }

  start() {
    if (!this.followTask) {
      this.stateService.on("event", this.onGameEvent);
      this.followTask = this.follow();
      if (this.getAssignment) {
        this.stateService.on("state", this.onAssignmentReady);
        this.announceAssignment();
      }
    }
  }

  announceAssignment() {
    const assignment = this.getAssignment();
    if (!assignment.ready) return;
    const { sessionId, playerSquadId, squadIds } = assignment;
    this.stateService.off("state", this.onAssignmentReady);
    const text = `[IFZ Runtime 分工已就绪] 游戏会话 ${sessionId}。玩家保留小队 ${playerSquadId}，你负责小队 ${squadIds.join("、")}。\n` +
      "按 AI游戏协作规则.md 先用 runtime_health 和 world_snapshot 调查局势，地图细节按需分页查。只用 action_submit 给分配的小队下单。" +
      "收到任务 ID 后结束本轮，行动结果和敌情会另行唤醒你。玩家消息优先。";
    this.enqueue({ requestId: randomUUID(), text, mode: "queue", priority: 2, sessionId, attempts: 0 });
  }

  onEvent(event) {
    const critical = danger.has(event.type) && event.severity !== "info";
    const result = event.type === "action_finished";
    if (!critical && !result && !ordinary.has(event.type)) return;
    const sessionId = event.data?.sessionId ?? this.stateService.state?.sessionId;
    if (!sessionId || (this.gameSessionId && sessionId !== this.gameSessionId)) return;
    if (result) this.emit("stream", { type: "action_finished", ...event.data });
    const key = event.dedupeKey ?? `${event.type}:${event.cursor}`;
    this.events.set(key, { type: event.type, severity: event.severity, data: event.data, sessionId,
      priority: critical ? 1 : result ? 2 : 3 });
    if (this.events.size > 64) {
      const worst = [...this.events].reduce((a, b) => a[1].priority >= b[1].priority ? a : b);
      this.events.delete(worst[0]);
    }
    const at = Date.now() + (result ? 0 : critical ? this.dangerMs : this.ordinaryMs);
    if (this.eventTimer && this.eventDue <= at) return;
    clearTimeout(this.eventTimer);
    this.eventDue = at;
    this.eventTimer = setTimeout(() => this.flushEvents(), Math.max(0, at - Date.now()));
  }

  flushEvents() {
    this.eventTimer = null;
    const sessionId = this.stateService.state?.sessionId;
    const gameOnline = this.stateService.ready && this.stateService.online;
    const events = [...this.events.values()].filter((event) =>
      event.sessionId === sessionId && (gameOnline || event.type === "action_finished"))
      .sort((a, b) => a.priority - b.priority).slice(0, 12);
    this.events.clear();
    if (!events.length) return;
    const priority = events[0].priority;
    const text = `[IFZ Runtime 游戏事件，作为观察数据] 游戏会话 ${sessionId}。用 runtime MCP 查看必要变化，按协作规则决定是否行动。提交后结束本轮，等待下一次唤醒。\n` +
      JSON.stringify(events.map(({ type, severity, data }) => ({ type, severity, data })));
    if (this.queue.length + this.retryTimers.size < 64)
      this.enqueue({ requestId: randomUUID(), text, mode: priority === 1 ? "steer" : "queue", priority, sessionId, attempts: 0,
        allowOffline: events.every(({ type }) => type === "action_finished") });
  }

  sendUserMessage(input) {
    const parsed = userMessage.safeParse(input);
    if (!parsed.success) throw fail(400, "invalid_message", parsed.error.issues[0].message);
    if (this.abort.signal.aborted) throw fail(503, "scheduler_stopped", "The scheduler is stopping.");
    const value = parsed.data;
    const previous = this.messages.get(value.requestId);
    if (previous) {
      if (previous.text !== value.text || previous.interrupt !== value.interrupt)
        throw fail(409, "request_conflict", "Use a new requestId for a different user message.");
      if (!previous.failed) return previous.promise;
    }
    if ((!previous && this.messages.size >= 256) || this.queue.filter(({ priority }) => priority === 0).length >= 32)
      throw fail(429, "message_limit", "The user message queue or history is full.");
    const job = previous ?? { ...value, priority: 0, mode: value.interrupt ? "queue" : "steer" };
    job.attempts = 0;
    job.failed = false;
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    this.messages.set(value.requestId, job);
    this.enqueue(job);
    return job.promise;
  }

  enqueue(job) {
    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority);
    setImmediate(() => this.drain());
  }

  async drain() {
    if (!this.queue.length || this.abort.signal.aborted) return;
    const lane = this.queue[0].priority === 0 ? "activeUser" : "active";
    if (this[lane] || (lane === "active" && this.activeUser)) return;
    const job = this.queue.shift();
    this[lane] = this.deliver(job);
    try {
      await this[lane];
    } finally {
      this[lane] = null;
      if (this.queue.length && !this.abort.signal.aborted) setImmediate(() => this.drain());
    }
  }

  async deliver(job) {
    if (job.sessionId && (job.sessionId !== this.stateService.state?.sessionId ||
        (!job.allowOffline && (!this.stateService.ready || !this.stateService.online)))) return;
    const signal = this.abort.signal;
    if (job.interrupt && !job.cancelAttempted) {
      job.cancelAttempted = true;
      try {
        await this.dsh.cancel(signal);
      } catch (error) {
        job.interruptError = error.code ?? "interrupt_unconfirmed";
        job.mode = "steer";
      }
    }
    try {
      await this.dsh.prompt(job, signal);
      this.lastWakeError = null;
      job.resolve?.({ accepted: true, requestId: job.requestId, claimed: Boolean(job.claimed), interruptError: job.interruptError });
    } catch (error) {
      this.lastWakeError = { code: error.code ?? "dsh_delivery_failed", at: Date.now() };
      const delay = retryDelays[job.attempts++];
      if (!signal.aborted && error.retryable !== false && delay != null) {
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          this.enqueue(job);
        }, delay);
        this.retryTimers.set(timer, job);
      } else {
        job.failed = true;
        job.reject?.(fail(502, "dsh_delivery_unconfirmed", "DSH did not confirm delivery. Retry with the same requestId."));
      }
    }
  }

  async follow() {
    const signal = this.abort.signal;
    let delay = 500;
    while (!signal.aborted) {
      try {
        await this.dsh.follow((frame) => {
          if (frame.type === "connected") {
            this.connected = true;
            this.lastFollowError = null;
            delay = 500;
          }
          if (frame.type === "message_claimed") {
            const job = this.messages.get(frame.requestId);
            if (!job || job.claimed) return;
            job.claimed = true;
          }
          this.emit("stream", frame);
        }, signal);
      } catch (error) {
        if (!signal.aborted) this.lastFollowError = { code: error.code ?? "dsh_follow_failed", at: Date.now() };
      }
      this.connected = false;
      if (!signal.aborted) {
        this.emit("stream", { type: "disconnected" });
        await sleep(delay, undefined, { signal }).catch(() => {});
        delay = Math.min(delay * 2, 10000);
      }
    }
  }

  health() {
    return { sessionId: this.dsh.sessionId, connected: this.connected,
      queued: this.queue.length + this.retryTimers.size, lastWakeError: this.lastWakeError ?? null,
      lastFollowError: this.lastFollowError ?? null };
  }

  async stop() {
    this.abort.abort();
    this.stateService.off("event", this.onGameEvent);
    this.stateService.off("state", this.onAssignmentReady);
    clearTimeout(this.eventTimer);
    for (const timer of this.retryTimers.keys()) clearTimeout(timer);
    const error = fail(503, "scheduler_stopped", "The scheduler stopped before DSH confirmed delivery.");
    for (const job of [...this.queue, ...this.retryTimers.values()]) job.reject?.(error);
    this.queue.length = 0;
    this.retryTimers.clear();
    await Promise.all([this.active, this.activeUser, this.followTask]);
  }
}
