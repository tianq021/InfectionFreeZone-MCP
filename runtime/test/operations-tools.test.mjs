import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerOperationsTools } from "../../tools-operations.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";
const recipe = (overrides = {}) => ({ recipe_id: "prod_food", unlocked: true,
  inputs_per_cycle: { res_grain: 4 }, outputs_per_cycle: { res_cans: 2 },
  active_game_hours_per_cycle: 2, active_game_hours_at_capacity: 1, ...overrides });
const facility = (overrides = {}) => ({ structure_id: "f1", type_id: "bld_cookhouse", name: "Kitchen",
  position: { x: 20, z: 20 }, production: { task_id: "t1", current_recipe_id: "prod_food", next_recipe_id: null,
    cycle_progress: 0.5, assigned_workers: 2, max_workers: 4, recipes: [recipe()] }, ...overrides });
const task = (overrides = {}) => ({ task_id: "t1", task_type: "ProductionWork", building_id: "f1",
  employment: "prof_worker", assigned_workers: 0, working_workers: 0, max_workers: 3, capacity: 3,
  vacancies: 3, assignable_now: 3, can_execute: true, paused: false, suspended: false, priority: null, ...overrides });
const progress = (overrides = {}) => ({ structure_id: "f1", current_recipe_id: "prod_food", next_recipe_id: null,
  cycle_progress: 0.5, assigned_workers: 2, working_workers: 2, max_workers: 4,
  remaining_game_hours: 1, missing_inputs: [], ...overrides });

function setup(options = {}) {
  const handlers = new Map(), schemas = new Map(), calls = [];
  const categories = options.categories ?? {};
  const facilities = options.facilities ?? { production: [facility()], defense: [], healthcare: [] };
  const tasks = options.tasks ?? [];
  const page = (items, args) => {
    const offset = args.offset ?? 0;
    const size = Math.min(args.limit ?? 100, options.pageSize ?? 100);
    return { ok: true, session_id: SESSION, items: items.slice(offset, offset + size),
      next_offset: offset + size < items.length ? offset + size : null };
  };
  registerOperationsTools({ registerLocal(name, _description, schema, handler) {
    schemas.set(name, z.object(schema)); handlers.set(name, handler);
  }, request: async (method, args = {}) => {
    calls.push({ method, args });
    if (options.errors?.[method]) throw Object.assign(new Error("Unavailable"), { code: options.errors[method] });
    if (method === "get_state") return { ok: true, ready: true, session_id: SESSION, time: {}, ...options.state };
    assert.equal(args.session_id, SESSION);
    if (method === "get_facilities") return page(facilities[args.category] ?? [], args);
    if (method === "get_world_data") return page(categories[args.category] ?? [], args);
    if (method === "get_workforce") return { ...page(tasks, args), mode: options.mode ?? "manual",
      alarm: options.alarm ?? false, available_workers: options.available === undefined ? 5 : options.available };
    if (method === "get_production_progress") return { ok: true, session_id: SESSION,
      facilities: options.progress === undefined ? [progress()] : options.progress };
    if (method === "get_current_weather") return { ok: true, session_id: SESSION, ...options.weather };
    if (method === "get_mood") return { ok: true, session_id: SESSION, unlocked: false, ...options.mood };
    throw new Error(`Unexpected method: ${method}`);
  } });
  return { calls, schemas, run: (name, args = {}) => handlers.get(name)(schemas.get(name).parse(args)) };
}

test("capacity uses native active hours and current recipe, excludes unstaffed unknowns", async () => {
  const zero = facility({ structure_id: "zero", production: { ...facility().production, assigned_workers: 0,
    recipes: [recipe({ active_game_hours_per_cycle: 9 })] } });
  const queued = facility({ structure_id: "queued", production: { ...facility().production, next_recipe_id: "other",
    recipes: [recipe(), recipe({ recipe_id: "other", outputs_per_cycle: { res_metal: 999 } })] } });
  const { run } = setup({ facilities: { production: [facility(), zero, queued] }, pageSize: 1 });
  const result = await run("get_production_capacity", { limit: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.known_inputs_per_active_game_hour, { res_grain: 4 });
  assert.deepEqual(result.known_outputs_per_active_game_hour, { res_cans: 2 });
  assert.equal(result.unknown_or_unstaffed_facilities, 1);
  assert.deepEqual(result.items[0].outputs_per_active_game_hour_at_capacity, { res_cans: 2 });
  assert.equal((await run("get_production_capacity", { structure_id: "zero" })).items[0].outputs_per_active_game_hour, null);
});

test("zero or missing cycle times never create infinite capacity", async () => {
  const { run } = setup({ facilities: { production: [facility({ production: { ...facility().production,
    recipes: [recipe({ active_game_hours_per_cycle: 0, active_game_hours_at_capacity: null })] } })] } });
  const result = await run("get_production_capacity");
  assert.deepEqual(result.known_outputs_per_active_game_hour, {});
  assert.equal(result.items[0].outputs_per_active_game_hour_at_capacity, null);
});

test("recipe search filters unlocked and resource matches using the real facility recipes", async () => {
  const { run } = setup({ facilities: { production: [facility({ production: { ...facility().production,
    recipes: [recipe(), recipe({ recipe_id: "locked", unlocked: false, outputs_per_cycle: { res_ammo: 1 } })] } })] } });
  assert.equal((await run("get_recipe_catalog")).total, 1);
  const locked = await run("get_recipe_catalog", { resource_id: "res_ammo", include_locked: true });
  assert.equal(locked.total, 1);
  assert.equal(locked.items[0].recipe_id, "locked");
  assert.equal(locked.items[0].selected, false);
  assert.equal((await run("get_recipe_catalog", { resource_id: "res_grain" })).total, 1);
});

test("bottlenecks join facility task ID and never assume a zero-worker ETA", async () => {
  const missing = [{ resource_id: "res_grain", needed_per_cycle: 4, in_stockpile: 0 }];
  const { run } = setup({ tasks: [task({ paused: true })],
    progress: [progress({ assigned_workers: 0, working_workers: 0, remaining_game_hours: 5, missing_inputs: missing })] });
  const result = await run("get_production_bottlenecks");
  assert.equal(result.items[0].task_id, "t1");
  assert.equal(result.items[0].remaining_game_hours_estimate, null);
  assert.deepEqual(result.items[0].reasons, ["paused", "unstaffed", "stockpile_below_cycle_inputs"]);
  assert.equal(result.items[0].reasons.includes("batch_blocked"), false);
  assert.equal((await run("get_production_bottlenecks", { structure_id: "none" })).total, 0);
});

test("healthcare deduplicates citizen and squad IDs and preserves unknown beds and health", async () => {
  const person = { id: "p1", hp: 25, max_hp: 100 };
  const { run } = setup({ facilities: { healthcare: [facility({ healthcare: { assigned_doctors: 2,
    treatment_beds: null, occupied_beds: null, available_staffed_beds: null } })] }, categories: {
    citizens: [person, { id: "unknown", hp: null, max_hp: 100 }, { id: "dead", hp: 0, max_hp: 100 }],
    squads: [{ id: "s1", members: [person, { id: "p2", hp: 60, max_hp: 80 }] }],
  } });
  const result = await run("get_healthcare_report", { limit: 1 });
  assert.equal(result.wounded.total, 2);
  assert.equal(result.wounded.truncated, true);
  assert.equal(result.wounded.items[0].squad_id, "s1");
  assert.equal(result.scanned_people, 4);
  assert.equal(result.unknown_health, 1);
  assert.deepEqual(result.totals.treatment_beds, { known_total: 0, unknown_count: 1 });
  assert.deepEqual(result.totals.assigned_doctors, { known_total: 2, unknown_count: 0 });
});

test("defense treats default weapons separately and empty stock ammo only as resupply risk", async () => {
  const defense = { task_id: "d1", selected_weapon_id: "eq_bow", assigned_guards: 2, max_guards: 2,
    options: [{ weapon_id: "eq_bow", is_default: true, at_structure: 0, in_stockpile: 0,
      ammo_id: "res_ammo", ammo_in_stockpile: 0 }] };
  const { run } = setup({ facilities: { defense: [facility({ defense })] } });
  const result = await run("get_defense_report", { only_issues: true });
  assert.deepEqual(result.items[0].issues, ["ammo_stockpile_empty"]);
  assert.equal(result.assigned_guards.known_total, 2);
});

test("manual workforce plan consumes a single budget and skips paused and non-executable work", async () => {
  const { run, calls } = setup({ pageSize: 2, available: 5, tasks: [
    task({ task_id: "a" }), task({ task_id: "b" }), task({ task_id: "c", paused: true }),
    task({ task_id: "d", can_execute: false }), task({ task_id: "z", employment: "prof_builder" }),
  ] });
  const result = await run("get_workforce_plan", { reserve_workers: 1, preferred_employment: "prof_builder" });
  assert.equal(result.total, 3);
  assert.equal(result.items[0].task_id, "z");
  assert.deepEqual(result.items.map(row => row.proposed_additional_workers), [3, 1, 0]);
  assert.equal(result.unallocated_workers, 0);
  assert.deepEqual(result.items[0].suggested_update, { mode: "manual", task_id: "z",
    setting: "assigned_workers", expected_value: 0, value: 3 });
  assert.ok(calls.every(call => call.method.startsWith("get_")));
});

test("priority mode and unknown available workers produce no proposed native writes", async () => {
  for (const options of [{ mode: "priorities" }, { available: null }]) {
    const result = await setup({ ...options, tasks: [task()] }).run("get_workforce_plan");
    assert.equal(result.items[0].proposed_additional_workers, null);
    assert.equal(result.items[0].suggested_update, null);
  }
});

test("construction queue excludes production and separates optional repair/demolition", async () => {
  const { run } = setup({ tasks: [task(), task({ task_id: "b", task_type: "BuildStructureWork" }),
    task({ task_id: "c", task_type: "CreateBuildingWork", paused: true }),
    task({ task_id: "d", task_type: "RepairStructureWork" }), task({ task_id: "e", task_type: "DeconstructWork" })] });
  const result = await run("get_construction_queue");
  assert.equal(result.total, 2);
  assert.equal(result.items[0].task_id, "c");
  assert.equal(result.items[0].issues.includes("paused"), true);
  assert.equal((await run("get_construction_queue", { include_maintenance: true })).total, 4);
});

test("alerts preserve partial source failures and suppress stale-session output", async () => {
  const { run } = setup({ errors: { get_mood: "unknown_method" }, weather: { severe_storm: true },
    state: { time: { popup_pause: true } }, tasks: [task({ paused: true })] });
  const result = await run("get_settlement_alerts", { limit: 1 });
  assert.equal(result.partial, true);
  assert.deepEqual(result.source_errors.map(row => row.source), ["mood"]);
  assert.equal(result.items[0].code, "severe_storm");
  assert.equal(result.truncated, true);
  await assert.rejects(setup({ errors: { get_mood: "session_changed" } }).run("get_settlement_alerts"),
    error => error.code === "session_changed");
});

test("missing required collection is an error, not a zero-facility report", async () => {
  await assert.rejects(setup({ progress: null }).run("get_production_bottlenecks"),
    error => error.code === "invalid_reply");
  await assert.rejects(setup({ errors: { get_facilities: "bridge_offline" } }).run("get_recipe_catalog"),
    error => error.code === "bridge_offline");
});

test("all eight operations tools reject invalid bounds before querying", async () => {
  const { schemas } = setup();
  assert.equal(schemas.size, 8);
  for (const schema of schemas.values()) {
    assert.equal(schema.safeParse({ limit: 0 }).success, false);
    assert.equal(schema.safeParse({ limit: 101 }).success, false);
    assert.equal(schema.safeParse({ limit: 1 }).success, true);
  }
});
