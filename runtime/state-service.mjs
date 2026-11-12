// Unified real-time game state service.
//
// Design goals:
// - one poller for the whole process, not one per consumer;
// - concurrent reads of independent categories (the bridge supports 4 concurrent pipes);
// - a monotonically increasing content version that ignores clock-only drift;
// - per-category deltas instead of full re-reads;
// - semantic events with dedupe/hysteresis for the scheduler to wake the model;
// - long-poll waiters so the model can "wait for something to happen" instead of polling.
import { EventEmitter } from "node:events";
import { nearbyScavengeQuery, readMapPage } from "../map-query.mjs";
import { createEventEngine, diffState, meaningfulHash } from "./events.mjs";

export const FAST_CATEGORIES = ["squads", "vehicles", "groups", "virtual_groups"];
export const MEDIUM_CATEGORIES = ["stockpile", "events", "stockrooms"];
export const SLOW_CATEGORIES = ["worksites", "weapons"];

const FIELD_BY_CATEGORY = {
  squads: "squads", vehicles: "vehicles", groups: "groups", virtual_groups: "virtualGroups",
  stockpile: "stockpile", events: "events", stockrooms: "stockrooms",
  buildings: "buildings", worksites: "worksites", weapons: "weapons",
  dialogue: "dialogue",
};
const CATEGORY_BY_FIELD = Object.fromEntries(Object.entries(FIELD_BY_CATEGORY).map(([category, field]) => [field, category]));

const PAGE_LIMIT = 100;
const ERROR_CODES_OFFLINE = new Set(["bridge_offline", "bridge_closed", "pipe_timeout", "ECONNREFUSED", "ENOENT"]);

const round = (value) => Math.round(value * 10) / 10;

export class StateService extends EventEmitter {
  constructor({ pipe, logger = console, config = {}, now = () => Date.now() } = {}) {
    super();
    if (!pipe) throw new Error("StateService needs a pipe client.");
    this.pipe = pipe;
    this.logger = logger;
    this.now = now;
    this.config = {
      fastIntervalMs: 500,
      mediumIntervalMs: 2000,
      slowIntervalMs: 15000,
      offlineRetryMs: 1500,
      includeBuildings: false,
      maxEvents: 1000,
      historyLimit: 60,
      eventConfig: {},
      ...config,
    };
    this.engine = createEventEngine({ config: this.config.eventConfig, now });
    this.state = null;
    this.version = 0;
    this.calls = 0;
    this.errors = 0;
    this.pollSeq = 0;
    this.events = [];
    this.eventCursor = 0;
    this.lastDialogueChoiceId = null;
    this.history = [];
    this.lastDiff = null;
    this.online = false;
    this.wasOffline = false;
    this.ready = false;
    this.lastPollAt = null;
    this.lastChangeAt = null;
    this.lastError = null;
    this.startedAt = null;
    this.timer = null;
    this.running = false;
    this.lastMediumAt = 0;
    this.lastSlowAt = 0;
    this.mediumCache = { stockpile: [], events: [], stockrooms: [] };
    this.slowCache = { worksites: [], weapons: [] };
    this.mapCache = { items: [], error: null, pending: null };
    this.waiters = [];
    this.eventWaiters = [];
    this.stats = { pollSeq: 0, pollErrors: 0, lastPollMs: 0, avgPollMs: 0, maxPollMs: 0, bridgeCalls: 0, bridgeErrors: 0, eventCount: 0, sessionChanges: 0, offlineCount: 0 };
  }

  // ---------------------------------------------------------------- lifecycle

  async start({ immediate = true } = {}) {
    if (this.running) return this;
    this.running = true;
    this.startedAt = this.now();
    if (immediate) await this.pollOnce().catch((error) => this.recordError(error));
    this.scheduleNext();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.resolveAllWaiters({ changed: false, reason: "stopped" });
    return this;
  }

  scheduleNext() {
    if (!this.running) return;
    const delay = this.online ? this.config.fastIntervalMs : this.config.offlineRetryMs;
    this.timer = setTimeout(async () => {
      try { await this.pollOnce(); } catch (error) { this.recordError(error); }
      this.scheduleNext();
    }, Math.max(20, delay));
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  // ---------------------------------------------------------------- polling

  async pollOnce({ forceSlow = false, forceMedium = false } = {}) {
    const started = this.now();
    this.pollSeq += 1;
    this.stats.pollSeq = this.pollSeq;
    try {
      const stateReply = await this.bridgeCall("get_state");
      if (stateReply?.ok === false || !stateReply?.ready) {
        const reason = stateReply?.code ?? "not_ready";
        this.online = true;
        this.handleNotReady(reason, stateReply);
        return this.state;
      }
      this.ready = true;
      const sessionId = stateReply.session_id;
      const sessionChanged = this.state != null && this.state.sessionId !== sessionId;
      if (sessionChanged) {
        this.engine.reset();
        this.lastDialogueChoiceId = null;
        this.mediumCache = { stockpile: [], events: [], stockrooms: [] };
        this.slowCache = { worksites: [], weapons: [] };
        this.mapCache = { items: [], error: null, pending: null };
        this.lastMediumAt = 0;
        this.lastSlowAt = 0;
        this.stats.sessionChanges += 1;
      }
      const now = this.now();
      const mediumDue = forceMedium || now - this.lastMediumAt >= this.config.mediumIntervalMs || this.lastMediumAt === 0;
      const slowDue = this.config.includeBuildings && (forceSlow || now - this.lastSlowAt >= this.config.slowIntervalMs || this.lastSlowAt === 0);
      const [fastRead, mediumRead, slowRead] = await Promise.all([
        this.readCategories(FAST_CATEGORIES, sessionId),
        mediumDue ? this.readCategories(MEDIUM_CATEGORIES, sessionId) : Promise.resolve(null),
        slowDue ? this.readCategories(SLOW_CATEGORIES, sessionId) : Promise.resolve(null),
      ]);
      if (mediumRead) { this.mediumCache = mediumRead; this.lastMediumAt = now; }
      if (slowRead) { this.slowCache = slowRead; this.lastSlowAt = now; }

      const previous = this.state;
      const next = this.buildState({ stateReply, fast: fastRead, now, sessionId });
      const hash = meaningfulHash(next);
      const previousHash = previous ? this.previousHash : null;
      const changed = previous == null || hash !== previousHash;
      this.previousHash = hash;

      let emitted = [];
      if (previous != null && !sessionChanged) {
        emitted = this.engine.detect(previous, next);
      } else if (previous == null) {
        // first snapshot: prime the engine without emitting a burst of "new" events
        this.engine.detect(null, next);
      }
      const choice = next.dialogue;
      if (choice?.choice_id && choice.choice_id !== this.lastDialogueChoiceId) {
        this.lastDialogueChoiceId = choice.choice_id;
        emitted.push({ type: "dialogue_options_available", severity: "warn",
          dedupeKey: `radio:${choice.choice_id}`, at: now, data: {
            sessionId, choiceId: choice.choice_id, transmissionId: choice.transmission_id,
            optionCount: choice.options?.filter(({ selectable }) => selectable).length ?? 0,
          } });
      }
      if (sessionChanged) {
        this.pushEvent({ type: "session_changed", severity: "warn", dedupeKey: `session:${sessionId}`, data: { sessionId } });
      }
      for (const event of emitted) this.pushEvent(event);

      if (changed || emitted.length) {
        this.version += 1;
        next.version = this.version;
        if (changed) {
          this.lastDiff = diffState({ ...previous, version: previous?.version ?? this.version - 1 }, next);
          this.history.push(this.lastDiff);
          if (this.history.length > this.config.historyLimit) this.history.shift();
        }
        this.lastChangeAt = now;
      } else {
        next.version = this.version;
      }
      this.state = next;
      this.markOnline();
      this.lastError = null;
      const elapsed = this.now() - started;
      this.stats.lastPollMs = round(elapsed);
      this.stats.avgPollMs = round((this.stats.avgPollMs * (this.pollSeq - 1) + elapsed) / this.pollSeq);
      this.stats.maxPollMs = Math.max(this.stats.maxPollMs, round(elapsed));
      this.lastPollAt = now;
      this.stats.bridgeCalls = Array.isArray(this.pipe.calls) ? this.pipe.calls.length : this.stats.bridgeCalls;
      this.emit("state", { version: this.version, changed, events: emitted });
      this.resolveWaiters();
      if (slowDue) this.refreshMap(sessionId, stateReply.headquarters);
      return this.state;
    } catch (error) {
      this.recordError(error);
      throw error;
    }
  }

  handleNotReady(reason, reply) {
    const wasReady = this.ready;
    this.ready = false;
    if (wasReady && reason !== "not_ready") {
      this.pushEvent({ type: "game_not_ready", severity: "warn", dedupeKey: "not_ready", data: { reason, reply: reply?.message ?? null } });
    }
    this.resolveWaiters();
  }

  recordError(error) {
    this.stats.pollErrors += 1;
    this.lastError = { code: error.code ?? "error", message: String(error.message ?? error), at: this.now() };
    const offline = ERROR_CODES_OFFLINE.has(error.code);
    if (offline) {
      if (this.online !== false || this.state == null) {
        this.online = false;
        this.wasOffline = true;
        this.stats.offlineCount += 1;
        this.pushEvent({ type: "bridge_offline", severity: "critical", dedupeKey: `offline:${this.stats.offlineCount}`, data: { code: this.lastError.code, message: this.lastError.message } });
        this.resolveWaiters();
      }
      this.online = false;
    } else {
      this.pushEvent({ type: "bridge_error", severity: "warn", dedupeKey: `bridge_error:${this.lastError.code}`, data: this.lastError });
    }
  }

  /** Called after a successful poll that follows an offline error. */
  markOnline() {
    if (!this.wasOffline) {
      this.online = true;
      return;
    }
    this.wasOffline = false;
    this.online = true;
    this.pushEvent({ type: "bridge_restored", severity: "info", dedupeKey: "restored", data: {} });
    this.resolveWaiters();
  }

  async bridgeCall(method, args = {}) {
    const reply = await this.pipe.call(method, args);
    if (reply?.ok === false && reply.code === "bridge_offline") throw Object.assign(new Error(reply.message ?? "bridge offline"), { code: "bridge_offline" });
    return reply;
  }

  async readCategory(category, sessionId) {
    const items = [];
    let offset = 0;
    let pages = 0;
    do {
      const page = await this.bridgeCall("get_world_data", { session_id: sessionId, category, limit: PAGE_LIMIT, offset });
      if (page?.ok === false) throw Object.assign(new Error(page.message ?? category), { code: page.code ?? "read_failed" });
      items.push(...(page.items ?? []));
      offset = page.next_offset;
      pages += 1;
      if (pages > 500) throw new Error(`Too many pages for ${category}`);
    } while (offset != null);
    return items;
  }

  async readCategories(categories, sessionId) {
    const entries = await Promise.all(categories.map(async (category) => [category, await this.readCategory(category, sessionId)]));
    return Object.fromEntries(entries);
  }

  refreshMap(sessionId, headquarters) {
    const cache = this.mapCache;
    if (!headquarters || cache.pending) return;
    const query = nearbyScavengeQuery(headquarters);
    const call = this.pipe.call.bind(this.pipe);
    cache.pending = (async () => {
      const items = [];
      let offset = 0;
      for (let pages = 0; pages < 500; pages += 1) {
        const page = await readMapPage(call, sessionId, { ...query, limit: PAGE_LIMIT, offset });
        if (cache !== this.mapCache) return;
        if (page.error) {
          cache.error = page.error;
          return;
        }
        items.push(...page.items);
        offset = page.next_offset;
        if (offset == null) {
          cache.items = items;
          cache.error = null;
          return;
        }
      }
      cache.error = { code: "map_page_limit", message: "Too many building pages." };
    })().catch((error) => {
      cache.error = { code: "map_query_failed", message: String(error?.message ?? error) };
    }).finally(() => { cache.pending = null; });
  }

  buildState({ stateReply, fast, now, sessionId }) {
    const buildings = this.mapCache.items.map(({ id, position }) => ({ id: String(id), position }));
    return {
      version: this.version,
      sessionId,
      at: now,
      ready: true,
      focused: Boolean(stateReply.focused),
      time: stateReply.time ?? null,
      dialogue: stateReply.dialogue ?? null,
      headquarters: stateReply.headquarters ?? null,
      game: {
        scene: stateReply.scene ?? stateReply.mode ?? null,
        paused: Boolean(stateReply.time?.paused),
        playerSquads: (stateReply.squads ?? []).map((squad) => ({
          id: String(squad.id), name: squad.name, moving: Boolean(squad.moving),
          inVehicle: Boolean(squad.in_vehicle), vehicleId: squad.vehicle_id ?? null,
        })),
      },
      squads: fast.squads ?? [],
      vehicles: fast.vehicles ?? [],
      groups: fast.groups ?? [],
      virtualGroups: fast.virtual_groups ?? [],
      stockpile: this.mediumCache.stockpile ?? [],
      events: this.mediumCache.events ?? [],
      stockrooms: this.mediumCache.stockrooms ?? [],
      buildings,
      worksites: (this.slowCache.worksites ?? []).filter(Boolean),
    };
  }

  // ---------------------------------------------------------------- events

  pushEvent(event) {
    const record = {
      ...event,
      cursor: ++this.eventCursor,
      stateVersion: this.version + 1,
    };
    this.events.push(record);
    if (this.events.length > this.config.maxEvents) this.events.shift();
    this.stats.eventCount += 1;
    this.emit("event", record);
    this.resolveEventWaiters();
    return record;
  }

  // ---------------------------------------------------------------- readers

  getCurrent({ since = null, categories = null } = {}) {
    if (!this.state) return { ok: false, code: "no_state", message: "State cache is empty; bridge may be offline." };
    const pickedCategories = categories?.length ? categories.map((category) => FIELD_BY_CATEGORY[category] ?? category) : null;
    if (since != null && Number(since) < this.version) {
      const delta = this.collectDelta(Number(since));
      if (delta) {
        if (!pickedCategories) return { ok: true, version: this.version, delta, changed: true };
        const filtered = this.filterDelta(delta, pickedCategories);
        return { ok: true, version: this.version, delta: filtered, changed: Object.keys(filtered).length > 2,
          at: this.state.at, sessionId: this.state.sessionId };
      }
    }
    const state = pickedCategories ? Object.fromEntries(pickedCategories.map((field) => [field, this.state[field]])) : this.state;
    return {
      ok: true, version: this.version, changed: since == null || Number(since) < this.version,
      full: true, at: this.state.at, sessionId: this.state.sessionId,
      state: pickedCategories ? { ...state, version: this.version, sessionId: this.state.sessionId, at: this.state.at } : state,
    };
  }

  filterDelta(delta, fields) {
    const reverse = new Map(Object.entries(FIELD_BY_CATEGORY).map(([category, field]) => [field, category]));
    const filtered = { fromVersion: delta.fromVersion, toVersion: delta.toVersion };
    for (const field of fields) {
      const category = reverse.get(field) ?? field;
      if (Object.hasOwn(delta, field)) filtered[category] = delta[field];
    }
    if (delta.header) filtered.header = delta.header;
    return filtered;
  }

  collectDelta(since) {
    if (!this.history.length) return null;
    const chain = this.history.filter((item) => item.toVersion > since);
    if (!chain.length) return null;
    if (chain[0].fromVersion > since) return null;
    const merged = { fromVersion: since, toVersion: this.version };
    for (const delta of chain) {
      for (const [key, value] of Object.entries(delta)) {
        if (key === "fromVersion" || key === "toVersion") continue;
        if (key === "header" || key === "dialogue") { merged[key] = value; continue; }
        if (!merged[key]) merged[key] = { added: [], updated: [], removed: [] };
        if (Array.isArray(value?.added)) merged[key].added.push(...value.added);
        if (Array.isArray(value?.updated)) merged[key].updated.push(...value.updated);
        if (Array.isArray(value?.removed)) merged[key].removed.push(...value.removed);
      }
    }
    return merged;
  }

  getEvents({ cursor = 0, types = null, limit = 100 } = {}) {
    const minimum = Number(cursor) || 0;
    let rows = this.events.filter((event) => event.cursor > minimum);
    if (types?.length) rows = rows.filter((event) => types.includes(event.type));
    const events = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { ok: true, cursor: hasMore ? events.at(-1).cursor : this.eventCursor, events, hasMore };
  }

  waitForChange({ since = null, timeoutMs = 5000, categories = null, signal } = {}) {
    if (since != null && this.version > since) {
      const current = this.getCurrent({ since, categories });
      if (current.changed) return Promise.resolve(current);
    }
    const result = () => ({ ok: true, changed: false, version: this.version });
    const pending = this.addWaiter(this.waiters, { since, categories }, timeoutMs, signal, result);
    this.emit("wait", { kind: "state", waiters: this.waiters.length });
    return pending;
  }

  waitForEvents({ cursor = 0, timeoutMs = 5000, types = null, signal } = {}) {
    const fresh = this.getEvents({ cursor, types });
    if (fresh.events.length) return Promise.resolve({ ...fresh, changed: true });
    return this.addWaiter(this.eventWaiters, { cursor, types }, timeoutMs, signal,
      () => ({ ok: true, changed: false, cursor: this.eventCursor, events: [] }));
  }

  addWaiter(waiters, fields, timeoutMs, signal, result) {
    return new Promise((resolve) => {
      const waiter = { ...fields, resolve: (value) => {
        this.removeWaiter(waiter);
        signal?.removeEventListener("abort", abort);
        resolve(value);
      } };
      const abort = () => waiter.resolve({ ...result(), aborted: true });
      if (signal?.aborted) return abort();
      waiter.timer = setTimeout(() => waiter.resolve({ ...result(), timeout: true }), Math.max(1, timeoutMs));
      waiter.timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      waiters.push(waiter);
    });
  }

  removeWaiter(waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    this.waiters = this.waiters.filter((item) => item !== waiter);
    this.eventWaiters = this.eventWaiters.filter((item) => item !== waiter);
  }

  resolveWaiters() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      if (waiter.since != null && this.version <= waiter.since) { this.waiters.push(waiter); continue; }
      const current = this.getCurrent({ since: waiter.since, categories: waiter.categories });
      if (!current.changed) { this.waiters.push(waiter); continue; }
      waiter.resolve(current);
    }
    this.resolveEventWaiters();
  }

  resolveEventWaiters() {
    if (!this.eventWaiters.length) return;
    const waiters = this.eventWaiters;
    this.eventWaiters = [];
    for (const waiter of waiters) {
      const fresh = this.getEvents({ cursor: waiter.cursor, types: waiter.types });
      if (!fresh.events.length) { this.eventWaiters.push(waiter); continue; }
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve({ ...fresh, changed: true });
    }
  }

  resolveAllWaiters(reason) {
    for (const waiter of [...this.waiters, ...this.eventWaiters]) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve({ ok: true, changed: false, reason });
    }
    this.waiters = [];
    this.eventWaiters = [];
  }

  health() {
    return {
      ok: true,
      online: this.online,
      ready: this.ready,
      version: this.version,
      sessionId: this.state?.sessionId ?? null,
      stateAt: this.state?.at ?? null,
      lastPollAt: this.lastPollAt,
      lastChangeAt: this.lastChangeAt,
      lastError: this.lastError,
      mapError: this.mapCache.error,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? this.now() - this.startedAt : 0,
      stats: { ...this.stats, pipeCalls: this.pipe.calls ?? null, pipeFailures: this.pipe.failures ?? null, waiters: this.waiters.length, eventWaiters: this.eventWaiters.length },
      config: {
        fastIntervalMs: this.config.fastIntervalMs,
        mediumIntervalMs: this.config.mediumIntervalMs,
        includeBuildings: this.config.includeBuildings,
      },
    };
  }
}
