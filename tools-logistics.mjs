// Logistics reports use existing read-only bridge endpoints; quantities remain in native units.
import { z } from "zod";
import { createQuery, finite, distance, bounded, queryError } from "./tools-query.mjs";

const id = z.string().trim().min(1).max(64);
const limit = z.number().int().min(1).max(100).optional();
const origin = z.object({ x: z.number().finite(), z: z.number().finite() }).optional();
const storage = z.enum(["physical", "virtual"]);
const count = value => finite(value) ? value : null;
const closest = (position, rows) => rows.map(row => ({ id: row.id, distance_m: distance(position, row.position) }))
  .filter(row => row.distance_m !== null).sort((a, b) => a.distance_m - b.distance_m || String(a.id).localeCompare(String(b.id)))[0] ?? null;
const nearFirst = (a, b) => (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity) || String(a.id ?? a.resource_id).localeCompare(String(b.id ?? b.resource_id));
const cargoRows = cargo => Object.entries(cargo ?? {}).filter(([, quantity]) => finite(quantity) && quantity > 0)
  .map(([resource_id, quantity]) => ({ resource_id, quantity })).sort((a, b) => a.resource_id.localeCompare(b.resource_id));
const sumResources = rows => {
  const values = new Map();
  for (const row of rows) if (finite(row.quantity)) values.set(row.resource_id, (values.get(row.resource_id) ?? 0) + row.quantity);
  return [...values].map(([resource_id, quantity]) => ({ resource_id, quantity })).sort((a, b) => a.resource_id.localeCompare(b.resource_id));
};
const stockRows = rows => rows.map(row => ({
  storage: row.storage, resource_id: row.resource_id, quantity: count(row.quantity), available: count(row.available),
  unavailable_during_exchange: finite(row.quantity) && finite(row.available) ? row.quantity - row.available : null,
})).sort((a, b) => String(a.storage).localeCompare(String(b.storage)) || a.resource_id.localeCompare(b.resource_id));

function carriers(squads, vehicles, includeOther = false) {
  const playerIds = new Set(squads.map(row => String(row.id)));
  return [
    ...squads.map(row => ({ kind: "squad", id: row.id, name: row.name, player_owned: true,
      position: row.position, vehicle_id: row.vehicle_id ?? null, cargo: cargoRows(row.cargo) })),
    ...vehicles.filter(row => includeOther || playerIds.has(String(row.owner_group_id))).map(row => ({
      kind: "vehicle", id: row.id, type: row.type, position: row.position,
      owner_group_id: row.owner_group_id ?? null, player_owned: playerIds.has(String(row.owner_group_id)),
      cargo: cargoRows(row.trunk?.cargo), occupied_slots: count(row.trunk?.occupied_slots),
      capacity_slots: count(row.trunk?.capacity_slots), available_slots: count(row.trunk?.available_slots),
      fuel_quantity: count(row.fuel?.quantity), fuel_ratio: count(row.fuel?.ratio),
    })),
  ];
}

export function registerLogisticsTools({ registerLocal, request }) {
  registerLocal("get_stockpile_report",
    "Read physical and virtual stock separately, including native total, available and amounts temporarily unavailable during resource exchange. Never adds virtual resources to physical stock. Paginate output with offset and limit.",
    { storage: storage.optional(), resource_id: id.optional(), offset: z.number().int().min(0).optional(), limit },
    async (args = {}) => {
      const q = await createQuery(request);
      const rows = stockRows(await q.world("stockpile")).filter(row => (!args.storage || row.storage === args.storage) && (!args.resource_id || row.resource_id === args.resource_id));
      const offset = args.offset ?? 0, size = args.limit ?? 30;
      return { ok: true, session_id: q.session_id, units: "native_resource_quantity", total: rows.length, offset,
        next_offset: offset + size < rows.length ? offset + size : null, truncated: offset > 0 || offset + size < rows.length,
        items: rows.slice(offset, offset + size), note: "Only positive native stock rows are emitted by the bridge. unavailable_during_exchange = quantity - native available; this is the game's exchanged-resource deduction, not construction reservations or locked crate slots. Physical and virtual containers remain separate." };
    });

  registerLocal("get_resource_catalog",
    "Search exact resource IDs and weapon ammunition mappings from the live game. Includes IDs observed in stock even when omitted from the editable-resource list. Does not invent resource names or crate sizes.",
    { search: z.string().trim().max(64).optional(), offset: z.number().int().min(0).optional(), limit },
    async (args = {}) => {
      const q = await createQuery(request);
      const [types, weapons, stock] = await Promise.all([q.world("resource_types"), q.world("weapons"), q.world("stockpile")]);
      const editable = new Set(types.map(row => row.resource_id));
      const weaponMap = new Map(weapons.map(row => [row.id, row]));
      const known = new Set([...editable, ...weaponMap.keys(), ...weapons.map(row => row.ammo_id).filter(Boolean), ...stock.map(row => row.resource_id)]);
      const search = (args.search ?? "").toLowerCase();
      const rows = [...known].filter(value => value.toLowerCase().includes(search)).sort().map(resource_id => {
        const weapon = weaponMap.get(resource_id);
        return { resource_id, listed_as_editable: editable.has(resource_id),
          observed_storage: [...new Set(stock.filter(row => row.resource_id === resource_id).map(row => row.storage))],
          weapon: weapon ? { melee: weapon.melee, ammo_id: weapon.ammo_id ?? null, magazine_capacity: count(weapon.magazine_capacity) } : null };
      });
      const offset = args.offset ?? 0, size = args.limit ?? 30;
      return { ok: true, session_id: q.session_id, total: rows.length, offset, next_offset: offset + size < rows.length ? offset + size : null,
        truncated: offset > 0 || offset + size < rows.length, items: rows.slice(offset, offset + size),
        note: "This is the union of public editable IDs, weapon/ammo IDs and current stock; it is not an exhaustive game database or a permission to modify stock." };
    });

  registerLocal("get_resource_budget",
    "Compare a requested resource budget with native available stock in ONE container (physical by default). Repeated resource IDs are added before calculating shortages. This preview does not reserve or spend resources.",
    { requirements: z.array(z.object({ resource_id: id, quantity: z.number().finite().min(0).max(1000000000) })).min(1).max(100), storage: storage.optional(), limit },
    async (args) => {
      const q = await createQuery(request);
      const [stock, types] = await Promise.all([q.world("stockpile"), q.world("resource_types")]);
      const known = new Set([...types, ...stock].map(row => row.resource_id));
      const requirements = sumResources(args.requirements);
      const unknown = requirements.filter(row => !known.has(row.resource_id)).map(row => row.resource_id);
      if (unknown.length) throw queryError("unknown_resource", `Unknown resource IDs: ${unknown.join(", ")}. Read get_resource_catalog.`);
      const selectedStorage = args.storage ?? "physical";
      const rows = requirements.map(row => {
        const source = stock.filter(entry => entry.storage === selectedStorage && entry.resource_id === row.resource_id);
        const available = source.every(entry => finite(entry.available)) ? source.reduce((sum, entry) => sum + entry.available, 0) : null;
        const quantity = source.every(entry => finite(entry.quantity)) ? source.reduce((sum, entry) => sum + entry.quantity, 0) : null;
        return { resource_id: row.resource_id, requested: row.quantity, quantity, available,
          shortage: available === null ? null : Math.max(0, row.quantity - Math.max(0, available)),
          affordable: available === null ? null : row.quantity <= Math.max(0, available) };
      });
      return { ok: true, session_id: q.session_id, storage: selectedStorage, units: "native_resource_quantity",
        affordable: rows.some(row => row.affordable === false) ? false : rows.some(row => row.affordable === null) ? null : true,
        shortage_count: rows.filter(row => row.affordable === false).length, ...bounded(rows, args.limit ?? 30),
        note: "Uses native GetAvailableResourceQuantity: total minus resources marked as exchanged. This does not account for future construction spending or locked crate slots. No cargo, ground resources, other storage container, crate conversion or resource reservation is included." };
    });

  registerLocal("get_resource_locations",
    "Locate a resource ID in player squad packs, player vehicle trunks and uncarried resource objects. Reports shared stock separately because its per-warehouse distribution is unavailable. Distances are straight-line, not routes.",
    { resource_id: id, origin, include_other_vehicles: z.boolean().optional(), limit },
    async (args) => {
      const q = await createQuery(request);
      const [stock, squads, vehicles, ground] = await Promise.all([q.world("stockpile"), q.world("squads"), q.world("vehicles"), q.world("ground_resources")]);
      const point = args.origin ?? q.state.headquarters;
      const items = carriers(squads, vehicles, args.include_other_vehicles === true).flatMap(row => row.cargo
        .filter(cargo => cargo.resource_id === args.resource_id).map(cargo => ({ kind: row.kind, id: row.id,
          owner_group_id: row.owner_group_id ?? null, player_owned: row.player_owned, position: row.position, quantity: cargo.quantity, distance_m: distance(point, row.position) })));
      items.push(...ground.filter(row => row.resource_id === args.resource_id).map(row => ({
        kind: "ground_resource", id: row.id, position: row.position, quantity: count(row.quantity), distance_m: distance(point, row.position),
      })));
      items.sort(nearFirst);
      return { ok: true, session_id: q.session_id, resource_id: args.resource_id, origin: point ?? null,
        shared_stock: stockRows(stock.filter(row => row.resource_id === args.resource_id)), ...bounded(items, args.limit ?? 30),
        scope: { other_vehicles_included: args.include_other_vehicles === true, ground_visibility_known: false, building_loot_included: false },
        note: "Ground objects may be hidden or inaccessible. Vehicle fuel tanks and equipped weapons/ammo are not cargo. No combined stock/cargo total is asserted." };
    });

  registerLocal("get_ground_resources_report",
    "Rank uncarried resource objects by distance and identify their nearest shared stockroom. Includes per-resource quantities and bounded results; visibility and traversability are not exposed by this source.",
    { origin, resource_id: id.optional(), radius: z.number().finite().min(0).max(100000).optional(), limit },
    async (args = {}) => {
      const q = await createQuery(request);
      const [ground, rooms] = await Promise.all([q.world("ground_resources"), q.world("stockrooms")]);
      const point = args.origin ?? q.state.headquarters;
      if (args.radius != null && distance(point, point) === null) throw queryError("origin_unavailable", "Provide origin coordinates to apply a radius filter.");
      const rows = ground.filter(row => !args.resource_id || row.resource_id === args.resource_id).map(row => ({
        id: row.id, resource_id: row.resource_id, quantity: count(row.quantity), position: row.position,
        distance_m: distance(point, row.position), nearest_stockroom: closest(row.position, rooms),
      })).filter(row => args.radius == null || (row.distance_m !== null && row.distance_m <= args.radius)).sort(nearFirst);
      return { ok: true, session_id: q.session_id, origin: point ?? null, radius: args.radius ?? null,
        ...bounded(rows, args.limit ?? 30), resources: bounded(sumResources(rows), args.limit ?? 30),
        note: "Counts every native uncarried resource object in scope, including objects whose visibility is unknown. Quantities are native units, not crate counts; nearest stockroom is geometric only." };
    });

  registerLocal("get_storage_report",
    "Inspect shared stockroom access points with nearest player squad and how many squads would use each as their closest return location. Inventory is global; per-stockroom amounts and capacities are not exposed.",
    { origin, limit },
    async (args = {}) => {
      const q = await createQuery(request);
      const [rooms, squads] = await Promise.all([q.world("stockrooms"), q.world("squads")]);
      const point = args.origin ?? q.state.headquarters;
      const assignments = squads.map(row => ({ squad_id: row.id, nearest: closest(row.position, rooms) }));
      const rows = rooms.map(row => ({ id: row.id, headquarters: row.headquarters, position: row.position,
        distance_m: distance(point, row.position), nearest_squad: closest(row.position, squads),
        nearest_for_squad_count: assignments.filter(entry => String(entry.nearest?.id) === String(row.id)).length,
        inventory: null, capacity: null })).sort(nearFirst);
      return { ok: true, session_id: q.session_id, origin: point ?? null, ...bounded(rows, args.limit ?? 30),
        squads_without_known_return_point: assignments.filter(row => row.nearest === null).length,
        note: "Shared-stockroom entries include eligible convoy structures. Inventory and capacity are unavailable in this bridge category. Straight-line proximity does not establish reachability." };
    });

  registerLocal("get_supply_network",
    "Rank active workforce tasks by straight-line distance to their nearest shared stockroom, exposing remote staffing locations. This is a geometric logistics diagnostic, not a pathfinder or proof of a production blockage.",
    { min_distance: z.number().finite().min(0).max(100000).optional(), only_staffed: z.boolean().optional(), limit },
    async (args = {}) => {
      const q = await createQuery(request);
      const [tasks, rooms] = await Promise.all([q.pages("get_workforce"), q.world("stockrooms")]);
      const rows = tasks.filter(row => !args.only_staffed || row.assigned_workers > 0).map(row => ({
        task_id: row.task_id, task_type: row.task_type, building_id: row.building_id ?? null, position: row.position,
        assigned_workers: count(row.assigned_workers), working_workers: count(row.working_workers),
        can_execute: row.can_execute ?? null, paused: row.paused ?? null, suspended: row.suspended ?? null,
        nearest_stockroom: closest(row.position, rooms),
      })).filter(row => args.min_distance == null || (row.nearest_stockroom !== null && row.nearest_stockroom.distance_m >= args.min_distance));
      rows.sort((a, b) => (b.nearest_stockroom?.distance_m ?? -1) - (a.nearest_stockroom?.distance_m ?? -1) || String(a.task_id).localeCompare(String(b.task_id)));
      return { ok: true, session_id: q.session_id, stockroom_count: rooms.length, ...bounded(rows, args.limit ?? 30),
        tasks_without_known_stockroom: rows.filter(row => row.nearest_stockroom === null).length,
        note: "All staffable task types may appear, including defense and construction. Distance alone does not imply missing supplies. Use plan_route to check actual routes." };
    });

  registerLocal("get_cargo_manifest",
    "List supplies still carried by player squads and vehicle trunks, with nearest stockroom and vehicle capacity/fuel. Packs and trunks are separate native containers; supplies are not added to settlement stock.",
    { include_empty: z.boolean().optional(), include_other_vehicles: z.boolean().optional(), resource_id: id.optional(), limit },
    async (args = {}) => {
      const q = await createQuery(request);
      const [squads, vehicles, rooms] = await Promise.all([q.world("squads"), q.world("vehicles"), q.world("stockrooms")]);
      const rows = carriers(squads, vehicles, args.include_other_vehicles === true)
        .map(row => ({ ...row, cargo: row.cargo.filter(item => !args.resource_id || item.resource_id === args.resource_id), nearest_stockroom: closest(row.position, rooms) }))
        .filter(row => args.include_empty === true || row.cargo.length > 0);
      rows.sort((a, b) => Number(b.player_owned) - Number(a.player_owned) || a.kind.localeCompare(b.kind) || String(a.id).localeCompare(String(b.id)));
      return { ok: true, session_id: q.session_id, ...bounded(rows, args.limit ?? 30),
        player_cargo_resources: bounded(sumResources(rows.filter(row => row.player_owned).flatMap(row => row.cargo)), args.limit ?? 30),
        other_vehicles_included: args.include_other_vehicles === true,
        note: "Resource totals cover all matched player carriers before output truncation, without ground or shared stock. Native quantities are distinct from trunk crate slots. Tank fuel and equipped items are excluded." };
    });
}
