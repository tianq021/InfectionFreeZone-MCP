import { z } from "zod";
import { createQuery, bounded, distance, finite, queryError } from "./tools-query.mjs";

const limitInput = z.number().int().min(1).max(100).optional();
const idInput = z.string().min(1).max(64);
const byDistance = (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity);
const hpRatio = m => finite(m.hp) && finite(m.max_hp) && m.max_hp > 0 ? m.hp / m.max_hp : null;
const withinRadius = (a, b, radius) => [a?.x, a?.z, b?.x, b?.z].every(finite)
  && Math.hypot(a.x - b.x, a.z - b.z) <= radius;
const selectedSquads = (squads, id) => {
  if (id == null) return squads;
  const selected = squads.filter(s => String(s.id) === id);
  if (!selected.length) throw queryError("squad_unavailable", "No current player squad has that ID.");
  return selected;
};

export function registerTacticalTools({ registerLocal, request }) {
  registerLocal("get_wounded_report", "Triage wounded citizens, workers and squad members by HP fraction; deduplicate overlapping rosters. Does not infer sickness or treatment eligibility.", {
    max_hp_ratio: z.number().min(0).max(1).optional(), limit: limitInput,
  }, async ({ max_hp_ratio = 1, limit = 30 }) => {
    const q = await createQuery(request);
    const [citizens, workers, squads] = await Promise.all([q.world("citizens"), q.world("workers"), q.world("squads")]);
    const people = new Map();
    for (const p of [...citizens, ...workers, ...squads.flatMap(s => s.members ?? [])]) {
      if (p.id == null) throw queryError("invalid_roster", "A character row is missing its ID.");
      people.set(String(p.id), p);
    }
    const rows = [...people.values()].map(p => ({ ...p, hp_ratio: hpRatio(p) }))
      .filter(p => p.hp_ratio != null && p.hp > 0 && p.hp_ratio < 1 && p.hp_ratio <= max_hp_ratio)
      .sort((a, b) => a.hp_ratio - b.hp_ratio);
    return { ok: true, session_id: q.session_id, scanned_people: people.size,
      unknown_health: [...people.values()].filter(p => hpRatio(p) == null).length,
      ...bounded(rows, limit), note: "HP triage only; health does not expose civilian sickness. Dead characters are excluded." };
  });

  registerLocal("get_squad_readiness", "Assess player squad HP, empty firearms, orders and vehicle fuel using configurable warning thresholds. Heuristic readiness flags are not a combat outcome prediction.", {
    squad_id: idInput.optional(), low_hp_ratio: z.number().min(0).max(1).optional(),
    low_fuel_ratio: z.number().min(0).max(1).optional(), limit: limitInput,
  }, async ({ squad_id, low_hp_ratio = 0.5, low_fuel_ratio = 0.2, limit = 30 }) => {
    const q = await createQuery(request);
    const [squads, vehicles, weapons] = await Promise.all([q.world("squads"), q.world("vehicles"), q.world("weapons")]);
    const catalog = new Map(weapons.map(w => [w.id, w]));
    const rows = selectedSquads(squads, squad_id).map(s => {
      const members = s.members ?? [];
      const vehicle = vehicles.find(v => String(v.id) === String(s.vehicle_id));
      const wounded = members.filter(m => hpRatio(m) != null && m.hp > 0 && hpRatio(m) < low_hp_ratio);
      const empty = members.filter(m => catalog.get(m.weapon_id)?.ammo_id && finite(m.ammo) && m.ammo <= 0);
      const flags = [];
      if (wounded.length) flags.push("low_health");
      if (empty.length) flags.push("empty_ammunition");
      if (finite(vehicle?.fuel?.ratio) && vehicle.fuel.ratio < low_fuel_ratio) flags.push("low_vehicle_fuel");
      if (members.length === 0) flags.push("no_members_reported");
      if (members.length > 0 && members.every(m => finite(m.hp) && m.hp <= 0)) flags.push("no_living_members_reported");
      if (finite(s.member_count) && s.member_count > members.length) flags.push("member_roster_truncated");
      if (members.some(m => hpRatio(m) == null || (m.weapon_id && !catalog.has(m.weapon_id))
        || (catalog.get(m.weapon_id)?.ammo_id && !finite(m.ammo)))) flags.push("incomplete_member_data");
      if (s.vehicle_id != null && (!vehicle || !finite(vehicle.fuel?.ratio))) flags.push("incomplete_vehicle_data");
      return { squad_id: s.id, name: s.name, active_order: s.active_order, queued_orders: s.queued_orders,
        member_count: s.member_count, sampled_members: members.length,
        low_health_member_ids: wounded.map(m => m.id), empty_ammo_member_ids: empty.map(m => m.id),
        vehicle_id: s.vehicle_id ?? null, vehicle_data_available: Boolean(vehicle),
        fuel_ratio: finite(vehicle?.fuel?.ratio) ? vehicle.fuel.ratio : null, flags };
    });
    return { ok: true, session_id: q.session_id, heuristic: true, thresholds: { low_hp_ratio, low_fuel_ratio }, ...bounded(rows, limit) };
  });

  registerLocal("get_ammo_supply_report", "Join squad weapons with ammunition stock: empty users, current carried ammo, physical available stock and virtual stock shown separately. Ammo units are native resource units, not estimated shots.", {
    squad_id: idInput.optional(), limit: limitInput,
  }, async ({ squad_id, limit = 30 }) => {
    const q = await createQuery(request);
    const [squads, weapons, stock] = await Promise.all([q.world("squads"), q.world("weapons"), q.world("stockpile")]);
    const catalog = new Map(weapons.map(w => [w.id, w]));
    const rows = new Map();
    let unknown = 0;
    for (const s of selectedSquads(squads, squad_id)) for (const m of s.members ?? []) {
      const w = catalog.get(m.weapon_id);
      if (!w) { if (m.weapon_id) unknown++; continue; }
      if (!w.ammo_id) continue;
      if (!rows.has(w.ammo_id)) rows.set(w.ammo_id, { resource_id: w.ammo_id, users: 0, empty_users: 0, unknown_ammo_users: 0, carried_quantity: 0 });
      const row = rows.get(w.ammo_id); row.users++;
      if (!finite(m.ammo)) row.unknown_ammo_users++;
      else { row.carried_quantity += m.ammo; if (m.ammo <= 0) row.empty_users++; }
    }
    for (const row of rows.values()) {
      const physical = stock.filter(s => s.resource_id === row.resource_id && s.storage === "physical");
      row.physical_available = physical.every(s => finite(s.available)) ? physical.reduce((n, s) => n + s.available, 0) : null;
      const virtual = stock.filter(s => s.resource_id === row.resource_id && s.storage === "virtual");
      row.virtual_quantity = virtual.every(s => finite(s.quantity)) ? virtual.reduce((n, s) => n + s.quantity, 0) : null;
    }
    return { ok: true, session_id: q.session_id, unknown_weapon_users: unknown, ...bounded([...rows.values()], limit) };
  });

  registerLocal("get_nearby_entities", "Find nearby squads, observed groups, discovered vehicles, stockrooms and ground resources around a world point. Distances are straight-line; hidden groups require include_hidden. Hostility comes from the bridge flag.", {
    x: z.number().finite(), z: z.number().finite(), radius: z.number().positive().max(10000).optional(),
    categories: z.array(z.enum(["squads", "groups", "vehicles", "stockrooms", "ground_resources"])).min(1).max(5).optional(),
    include_hidden: z.boolean().optional(), limit: limitInput,
  }, async ({ x, z: coordZ, radius = 300, categories = ["squads", "groups", "vehicles", "stockrooms", "ground_resources"], include_hidden = false, limit = 30 }) => {
    const q = await createQuery(request);
    const rows = [];
    const categoriesData = await Promise.all([...new Set(categories)].map(async category => [category, await q.world(category)]));
    const squadIds = new Set((categoriesData.find(([category]) => category === "squads")?.[1] ?? [])
      .filter(squad => squad.id != null).map(squad => String(squad.id)));
    for (const [category, entities] of categoriesData) for (const entity of entities) {
      if (category === "groups" && entity.id != null && squadIds.has(String(entity.id))) continue;
      if (category === "groups" && !include_hidden && entity.visible !== true) continue;
      const d = distance({ x, z: coordZ }, entity.position);
      if (!withinRadius({ x, z: coordZ }, entity.position, radius)) continue;
      rows.push({ category, id: entity.id, name: entity.name ?? entity.type ?? entity.resource_id ?? null,
        position: entity.position, distance: d, faction: entity.faction ?? null,
        hostile_to_player: entity.hostile_to_player ?? null, visible: entity.visible ?? null,
        quantity: entity.quantity ?? null, member_count: entity.member_count ?? null });
    }
    return { ok: true, session_id: q.session_id, center: { x, z: coordZ }, radius, distance_kind: "straight_line", ...bounded(rows.sort(byDistance), limit) };
  });

  registerLocal("get_return_options", "Rank shared stockrooms for one player squad, with nearby confirmed hostile groups. Does not validate routes or issue a return order; use plan_route and return_to_stockroom after review.", {
    squad_id: idInput, threat_radius: z.number().positive().max(2000).optional(), limit: limitInput,
  }, async ({ squad_id, threat_radius = 200, limit = 30 }) => {
    const q = await createQuery(request);
    const [squads, rooms, groups] = await Promise.all([q.world("squads"), q.world("stockrooms"), q.world("groups")]);
    const squad = selectedSquads(squads, squad_id)[0];
    const rows = rooms.map(room => ({ stockroom_id: room.id, headquarters: room.headquarters,
      position: room.position, distance: distance(squad.position, room.position),
      nearby_hostile_groups: groups.filter(g => g.hostile_to_player === true && withinRadius(g.position, room.position, threat_radius)).length,
    })).sort(byDistance);
    return { ok: true, session_id: q.session_id, squad_id, threat_radius, distance_kind: "straight_line", route_checked: false, ...bounded(rows, limit) };
  });

  registerLocal("get_mission_deadlines", "List active missions with the native time-limit data and objective completion counts. Values retain bridge units; no invented deadline or remaining-time conversion.", { limit: limitInput }, async ({ limit = 30 }) => {
    const q = await createQuery(request);
    const reply = await q.call("get_missions", { include_types: false });
    if (!Array.isArray(reply.missions)) throw queryError("invalid_missions", "The bridge returned no missions array.");
    const rows = reply.missions.map(m => ({ mission_id: m.id, title_key: m.title_key,
      time_to_resolve: finite(m.time_to_resolve) ? m.time_to_resolve : null,
      time_to_resolve01: finite(m.time_to_resolve01) ? m.time_to_resolve01 : null, chapter_id: m.chapter_id ?? null,
      blocking_new_zone: m.blocking_new_zone ?? null,
      objective_count: Array.isArray(m.objectives) ? m.objectives.length : null,
      completed_objectives: Array.isArray(m.objectives) ? m.objectives.filter(o => o?.completed === true).length : null }))
      .sort((a, b) => (a.time_to_resolve > 0 ? a.time_to_resolve : Infinity) - (b.time_to_resolve > 0 ? b.time_to_resolve : Infinity));
    return { ok: true, session_id: q.session_id, time: q.state.time, ...bounded(rows, limit) };
  });
}
