// Read-only operational reports over existing native bridge methods.
import { z } from "zod";
import { bounded, createQuery, finite, queryError } from "./tools-query.mjs";

const limitInput = z.number().int().min(1).max(100).optional();
const idInput = z.string().min(1).max(96).optional();
const constructionTypes = new Set(["CreateBuildingWork", "BuildStructureWork", "ExtraAdaptationWork"]);
const maintenanceTypes = new Set(["RepairStructureWork", "DeconstructWork", "MendWork"]);
const numeric = value => finite(value) ? value : null;
const round = value => Math.round(value * 1000) / 1000;
const sumKnown = (rows, key) => ({
  known_total: rows.reduce((sum, row) => sum + (finite(row[key]) ? row[key] : 0), 0),
  unknown_count: rows.filter(row => !finite(row[key])).length,
});
const array = (value, field) => {
  if (!Array.isArray(value)) throw queryError("invalid_reply", `Bridge reply is missing ${field}.`);
  return value;
};
const identify = row => ({ structure_id: row.structure_id, type_id: row.type_id, name: row.name, position: row.position });

async function workforce(q) {
  const first = await q.call("get_workforce", { offset: 0, limit: 100 });
  array(first.items, "workforce.items");
  const tasks = first.next_offset == null ? first.items : await q.pages("get_workforce");
  return { mode: first.mode, available_workers: numeric(first.available_workers), alarm: first.alarm ?? null, tasks };
}

function taskReasons(task) {
  const reasons = [];
  if (task.paused === true) reasons.push("paused");
  if (task.suspended === true) reasons.push("suspended");
  if (task.can_execute === false) reasons.push("cannot_execute");
  if (task.max_workers === 0) reasons.push("worker_limit_zero");
  if (task.assigned_workers === 0 && task.max_workers > 0) reasons.push("unstaffed");
  if (task.assigned_workers > 0 && task.working_workers === 0) reasons.push("no_workers_currently_working");
  return reasons;
}

function productionReasons(row, task) {
  const reasons = task ? taskReasons(task) : [];
  if (!row.current_recipe_id) reasons.push("no_current_recipe");
  if (row.assigned_workers === 0) reasons.push("unstaffed");
  if (row.assigned_workers > 0 && row.working_workers === 0) reasons.push("no_workers_currently_working");
  if (Array.isArray(row.missing_inputs) && row.missing_inputs.length) reasons.push("stockpile_below_cycle_inputs");
  return [...new Set(reasons)];
}

function rates(resources, hours) {
  if (!resources || typeof resources !== "object" || Array.isArray(resources) || !finite(hours) || hours <= 0) return null;
  return Object.fromEntries(Object.entries(resources).filter(([, quantity]) => finite(quantity) && quantity > 0)
    .map(([id, quantity]) => [id, round(quantity / hours)]));
}

function woundedPeople(citizens, squads) {
  const people = new Map();
  let anonymous = 0;
  const add = (person, squadId = null) => {
    const key = person.id == null ? `anonymous:${anonymous++}` : String(person.id);
    const prior = people.get(key);
    people.set(key, { ...prior, ...person, squad_id: squadId ?? prior?.squad_id ?? null });
  };
  citizens.forEach(person => add(person));
  squads.forEach(squad => (squad.members ?? []).forEach(person => add(person, squad.id)));
  const rows = [...people.values()];
  const known = rows.filter(person => finite(person.hp) && finite(person.max_hp) && person.max_hp > 0);
  return {
    scanned_people: rows.length,
    unknown_health: rows.length - known.length,
    wounded: known.filter(person => person.hp > 0 && person.hp < person.max_hp)
      .map(person => ({ id: person.id, name: person.name, squad_id: person.squad_id, hp: person.hp,
        max_hp: person.max_hp, hp_ratio: round(person.hp / person.max_hp), position: person.position }))
      .sort((a, b) => a.hp_ratio - b.hp_ratio || String(a.id).localeCompare(String(b.id))),
  };
}

export function registerOperationsTools({ registerLocal, request }) {
  const register = (name, description, schema, handler) => registerLocal(name, description, schema, async args => {
    const q = await createQuery(request);
    return { ok: true, session_id: q.session_id, ...(await handler(q, args ?? {})) };
  });

  register("get_production_bottlenecks",
    "Diagnose current production staffing, pauses and stockpile shortages with native evidence. A low stockpile does not prove an in-progress batch is blocked; inputs may already be delivered.",
    { limit: limitInput, structure_id: idInput }, async (q, { limit = 30, structure_id }) => {
      const [progress, facilities, work] = await Promise.all([
        q.call("get_production_progress"), q.pages("get_facilities", { category: "production" }), workforce(q),
      ]);
      const tasks = new Map(work.tasks.map(task => [String(task.task_id), task]));
      const taskIds = new Map(facilities.map(row => [String(row.structure_id), row.production?.task_id]));
      const rows = array(progress.facilities, "facilities")
        .filter(row => structure_id == null || String(row.structure_id) === structure_id).map(row => {
          const task = tasks.get(String(taskIds.get(String(row.structure_id))));
          return { ...identify(row), task_id: task?.task_id ?? null,
            current_recipe_id: row.current_recipe_id ?? null, next_recipe_id: row.next_recipe_id ?? null,
            cycle_progress: numeric(row.cycle_progress), assigned_workers: numeric(row.assigned_workers),
            working_workers: numeric(row.working_workers), missing_inputs: row.missing_inputs ?? null,
            reasons: productionReasons(row, task),
            remaining_game_hours_estimate: row.assigned_workers > 0 && row.working_workers > 0
              ? numeric(row.remaining_game_hours) : null };
        });
      const issues = rows.filter(row => row.reasons.length).sort((a, b) => b.reasons.length - a.reasons.length);
      return { scanned_facilities: rows.length, issue_count: issues.length, ...bounded(issues, limit),
        assumptions: ["Stockpile input checks apply to a whole cycle, not to materials already delivered to a batch.",
          "Working-worker counts are instantaneous; zero can also mean travel or logistics."] };
    });

  register("get_recipe_catalog",
    "Search recipes offered by completed player production facilities, including unlock state, per-cycle inputs/outputs and native active game-hour estimates. Optional resource filter matches inputs or outputs.",
    { limit: limitInput, recipe_id: idInput, resource_id: idInput, include_locked: z.boolean().optional() },
    async (q, { limit = 30, recipe_id, resource_id, include_locked = false }) => {
      const facilities = await q.pages("get_facilities", { category: "production" });
      const rows = facilities.flatMap(facility => array(facility.production?.recipes, "production.recipes")
        .filter(recipe => (include_locked || recipe.unlocked === true) && (!recipe_id || recipe.recipe_id === recipe_id)
          && (!resource_id || Object.hasOwn(recipe.inputs_per_cycle ?? {}, resource_id) || Object.hasOwn(recipe.outputs_per_cycle ?? {}, resource_id)))
        .map(recipe => ({ ...identify(facility), ...recipe,
          selected: facility.production.current_recipe_id === recipe.recipe_id,
          queued: facility.production.next_recipe_id === recipe.recipe_id })));
      return { scope: "recipes_of_completed_player_facilities", facility_count: facilities.length, ...bounded(rows, limit) };
    });

  register("get_production_capacity",
    "Calculate theoretical input and output rates per active in-game hour for the CURRENT recipe at each facility, using native staffing/weather/mood cycle times. Rates are not a forecast of actual daily production.",
    { limit: limitInput, structure_id: idInput }, async (q, { limit = 30, structure_id }) => {
      const facilities = (await q.pages("get_facilities", { category: "production" }))
        .filter(row => !structure_id || String(row.structure_id) === structure_id);
      const rows = facilities.map(facility => {
        const production = facility.production;
        const recipe = array(production?.recipes, "production.recipes").find(row => row.recipe_id === production.current_recipe_id);
        const hours = production.assigned_workers > 0 ? numeric(recipe?.active_game_hours_per_cycle) : null;
        const fullHours = numeric(recipe?.active_game_hours_at_capacity);
        return { ...identify(facility), current_recipe_id: production.current_recipe_id ?? null,
          assigned_workers: numeric(production.assigned_workers), max_workers: numeric(production.max_workers),
          active_game_hours_per_cycle: hours, active_game_hours_at_capacity: fullHours,
          inputs_per_active_game_hour: rates(recipe?.inputs_per_cycle, hours),
          outputs_per_active_game_hour: rates(recipe?.outputs_per_cycle, hours),
          outputs_per_active_game_hour_at_capacity: rates(recipe?.outputs_per_cycle, fullHours) };
      });
      const inputs = {}, outputs = {};
      for (const row of rows) {
        for (const [id, quantity] of Object.entries(row.inputs_per_active_game_hour ?? {})) inputs[id] = round((inputs[id] ?? 0) + quantity);
        for (const [id, quantity] of Object.entries(row.outputs_per_active_game_hour ?? {})) outputs[id] = round((outputs[id] ?? 0) + quantity);
      }
      return { ...bounded(rows, limit), known_inputs_per_active_game_hour: inputs, known_outputs_per_active_game_hour: outputs,
        unknown_or_unstaffed_facilities: rows.filter(row => row.outputs_per_active_game_hour == null).length,
        assumptions: ["Only the current recipe is counted; pending recipe changes are excluded.",
          "Assumes continuous active work, sufficient inputs and output space; excludes shifts, pauses, travel and logistics.",
          "Rates use game hours, not real-world hours. Full-capacity rates use native workplace capacity, not the current worker limit."] };
    });

  register("get_healthcare_report",
    "Summarize doctors, hospital bed availability and wounded living citizens/squad members, deduplicated by character ID. Missing health or bed data remains unknown; does not assume every wounded person can use a hospital bed.",
    { limit: limitInput }, async (q, { limit = 30 }) => {
      const [facilities, citizens, squads] = await Promise.all([
        q.pages("get_facilities", { category: "healthcare" }), q.world("citizens"), q.world("squads"),
      ]);
      const health = facilities.map(row => ({ ...identify(row), ...(row.healthcare ?? {}) }));
      const people = woundedPeople(citizens, squads);
      return { facilities: bounded(health, limit), wounded: bounded(people.wounded, limit),
        scanned_people: people.scanned_people, unknown_health: people.unknown_health,
        totals: Object.fromEntries(["assigned_doctors", "treatment_beds", "occupied_beds", "available_staffed_beds"].map(key => [key, sumKnown(health, key)])),
        limitations: ["Treatment beds and civilian healing are different native mechanisms; wounded count is not a bed demand forecast."] };
    });

  register("get_defense_report",
    "Audit completed defense facilities for guard staffing, selected weapons, weapons at the structure and stockpile ammunition. Empty stockpile ammo is a resupply risk, not proof that the structure cannot fire.",
    { limit: limitInput, only_issues: z.boolean().optional() }, async (q, { limit = 30, only_issues = false }) => {
      const facilities = await q.pages("get_facilities", { category: "defense" });
      const rows = facilities.map(facility => {
        const defense = facility.defense ?? {};
        const selected = array(defense.options, "defense.options").find(option => option.weapon_id === defense.selected_weapon_id);
        const issues = [];
        if (defense.assigned_guards === 0) issues.push("no_guards_assigned");
        if (defense.max_guards === 0) issues.push("guard_limit_zero");
        if (!defense.selected_weapon_id) issues.push("no_selected_weapon");
        if (selected && selected.is_default === false && selected.at_structure === 0) issues.push("selected_weapon_not_at_structure");
        if (selected?.ammo_id && selected.ammo_in_stockpile === 0) issues.push("ammo_stockpile_empty");
        return { ...identify(facility), task_id: defense.task_id ?? null,
          selected_weapon_id: defense.selected_weapon_id ?? null, assigned_guards: numeric(defense.assigned_guards),
          max_guards: numeric(defense.max_guards), selected_weapon_supply: selected ?? null, issues };
      });
      return { scanned_facilities: rows.length, facilities_with_issues: rows.filter(row => row.issues.length).length,
        assigned_guards: sumKnown(rows, "assigned_guards"),
        ...bounded((only_issues ? rows.filter(row => row.issues.length) : rows).sort((a, b) => b.issues.length - a.issues.length), limit),
        limitations: ["Does not measure firing range, line of sight, ammunition already loaded, or coverage geometry."] };
    });

  register("get_workforce_plan",
    "Propose read-only staffing changes for executable tasks, spending a single available-worker budget. Manual mode returns expected-value assignments; priorities mode reports candidate tasks only because native scheduling controls assignment.",
    { limit: limitInput, reserve_workers: z.number().int().min(0).max(100000).optional(),
      preferred_employment: z.string().min(1).max(96).optional() },
    async (q, { limit = 30, reserve_workers = 0, preferred_employment }) => {
      const work = await workforce(q);
      const budget = work.available_workers == null ? null : Math.max(0, Math.floor(work.available_workers) - reserve_workers);
      let remaining = budget;
      const candidates = work.tasks.filter(task => task.can_execute === true && task.paused === false && task.suspended === false
        && finite(task.vacancies) && task.vacancies > 0 && finite(task.assignable_now) && task.assignable_now > 0)
        .sort((a, b) => Number(b.employment === preferred_employment) - Number(a.employment === preferred_employment)
          || Number(b.assigned_workers === 0) - Number(a.assigned_workers === 0)
          || (b.priority ?? 0) - (a.priority ?? 0) || String(a.task_id).localeCompare(String(b.task_id)));
      const rows = candidates.map(task => {
        const proposed = work.mode === "manual" && remaining != null && finite(task.assigned_workers)
          ? Math.max(0, Math.min(remaining, Math.floor(task.vacancies), Math.floor(task.assignable_now))) : null;
        if (proposed != null) remaining -= proposed;
        return { task_id: task.task_id, building_id: task.building_id, employment: task.employment,
          task_type: task.task_type, position: task.position, assigned_workers: task.assigned_workers,
          vacancies: task.vacancies, priority: task.priority ?? null, proposed_additional_workers: proposed,
          suggested_update: proposed > 0 ? { mode: "manual", task_id: task.task_id, setting: "assigned_workers",
            expected_value: task.assigned_workers, value: task.assigned_workers + proposed } : null };
      });
      return { mode: work.mode, alarm: work.alarm, available_workers: work.available_workers,
        reserve_workers, allocation_budget: budget, unallocated_workers: remaining,
        ...bounded(rows, limit), policy: "Preferred employment first, then unstaffed tasks, then native priority and task ID.",
        limitations: ["Advisory only. Re-read workforce before applying; worker availability and expected values can change.",
          "Priorities mode does not support direct assignment, so it returns no suggested writes."] };
    });

  register("get_construction_queue",
    "Read active native construction/adaptation staffing tasks, optionally repairs and demolition. Includes task IDs, blockers and vacancies; native queue submission order and completion ETA are unavailable.",
    { limit: limitInput, include_maintenance: z.boolean().optional() }, async (q, { limit = 30, include_maintenance = false }) => {
      const work = await workforce(q);
      const rows = work.tasks.filter(task => constructionTypes.has(task.task_type) || (include_maintenance && maintenanceTypes.has(task.task_type)))
        .map(task => ({ ...task, maintenance: maintenanceTypes.has(task.task_type), issues: taskReasons(task) }))
        .sort((a, b) => b.issues.length - a.issues.length || String(a.task_id).localeCompare(String(b.task_id)));
      return { mode: work.mode, available_workers: work.available_workers, ...bounded(rows, limit),
        assigned_workers: sumKnown(rows, "assigned_workers"), vacancies: sumKnown(rows, "vacancies"),
        scope: "active_native_staffable_tasks", ordering: "issue_count_then_task_id_not_submission_order",
        limitations: ["Does not include a newly submitted placement before the native work task exists. No progress or ETA is inferred."] };
    });

  register("get_settlement_alerts",
    "Collect evidence-based alerts for pauses, severe weather, mood efficiency, production input shortages and interrupted staffing. Failed optional sources are explicitly reported as partial data, never as a healthy settlement.",
    { limit: limitInput }, async (q, { limit = 30 }) => {
      const alerts = [], sourceErrors = [];
      const sources = [
        ["weather", () => q.call("get_current_weather")], ["mood", () => q.call("get_mood")],
        ["production", () => q.call("get_production_progress")], ["workforce", () => workforce(q)],
      ];
      const replies = await Promise.allSettled(sources.map(([, call]) => call()));
      const data = {};
      replies.forEach((reply, index) => {
        const name = sources[index][0];
        if (reply.status === "fulfilled") data[name] = reply.value;
        else {
          if (["session_changed", "invalid_session", "stale_session"].includes(reply.reason?.code)) throw reply.reason;
          sourceErrors.push({ source: name, code: reply.reason?.code ?? "query_failed", message: reply.reason?.message ?? "Source unavailable" });
        }
      });
      const add = (severity, code, source, evidence) => alerts.push({ severity, code, source, evidence });
      if (q.state.time?.popup_pause || q.state.time?.ui_pause || q.state.radio_paused) add("info", "interaction_pause", "state", {
        popup_pause: q.state.time.popup_pause, ui_pause: q.state.time.ui_pause, radio_paused: q.state.radio_paused });
      else if (q.state.time?.paused) add("info", "simulation_paused", "state", { paused: true });
      if (data.weather?.severe_storm === true) add("warning", "severe_storm", "weather", { severe_storm: true });
      if (data.weather?.frost === true) add("warning", "frost", "weather", { temperature_c: data.weather.temperature_c });
      if (data.mood?.unlocked === true && data.mood.effects?.worker_efficiency_change_percent < 0) add("warning", "mood_reduces_efficiency", "mood", {
        level_name: data.mood.level_name, efficiency_change_percent: data.mood.effects.worker_efficiency_change_percent });
      if (data.production) for (const row of array(data.production.facilities, "facilities")) {
        if (Array.isArray(row.missing_inputs) && row.missing_inputs.length) add("warning", "stockpile_below_cycle_inputs", "production", {
          structure_id: row.structure_id, current_recipe_id: row.current_recipe_id, missing_inputs: row.missing_inputs });
      }
      if (data.workforce) {
        if (data.workforce.alarm === true) add("warning", "workforce_alarm", "workforce", { alarm: true });
        for (const task of data.workforce.tasks) {
          const reasons = taskReasons(task);
          if (reasons.length) add("info", "work_task_attention", "workforce", { task_id: task.task_id, building_id: task.building_id, reasons });
        }
      }
      alerts.sort((a, b) => Number(b.severity === "warning") - Number(a.severity === "warning"));
      return { partial: sourceErrors.length > 0, source_errors: sourceErrors, ...bounded(alerts, limit),
        coverage: ["state", ...Object.keys(data)],
        limitations: ["Alerts report observations, not proof of a stalled batch or an exhaustive safety assessment."] };
    });
}
