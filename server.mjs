import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerMapQuery } from "./map-query.mjs";
import { getWeather } from "./weather.mjs";
import { registerExtraTools } from "./tools-extra.mjs";
import { registerMoreTools } from "./tools-extra2.mjs";
import { registerEnemyTools } from "./tools-extra3.mjs";
import { registerTools4 } from "./tools-extra4.mjs";
import { registerLogisticsTools } from "./tools-logistics.mjs";
import { registerOperationsTools } from "./tools-operations.mjs";
import { registerTacticalTools } from "./tools-tactical.mjs";
import { dialogueChoiceInput } from "./runtime/dialogue.mjs";
import { createPipeClient } from "./runtime/pipe-client.mjs";
import { registerCheatTools } from "./cheat-tools.mjs";
import { localizeDescription, resolveLanguage, LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "./i18n.mjs";

const language = resolveLanguage();
const steamMode = process.argv.includes("--steam");
const workforceOnly = process.argv.includes("--workforce-only");
const strictReadOnly = process.argv.includes("--read-only");
const readOnly = workforceOnly || strictReadOnly;
const allowWorkforceWrites = !strictReadOnly;
const allowConstruction = !readOnly || (workforceOnly && allowWorkforceWrites && process.argv.includes("--allow-construction"));
const enableCheats = !workforceOnly && process.argv.includes("--enable-cheats");
const pipe = createPipeClient({ steam: steamMode, maxResponseSize: 1024 * 1024 });
const request = (method, args) => pipe.call(method, args);
const bridgeErrors = new Set(["bridge_offline", "bridge_busy", "pipe_timeout", "bridge_closed", "bridge_protocol"]);
const toolCatalog = new Map();
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const server = new McpServer({ name: "infection-free-zone", version: "0.2.2" });
process.stderr.write(`[ifz-mcp] language=${language} (${LANGUAGE_LABELS[language] ?? language}); supported=${SUPPORTED_LANGUAGES.join(",")}\n`);

const lease = z.string().uuid().describe("Token returned by acquire_control");
const session = z.string().uuid().describe("Current session_id from get_state");
const orderId = z.string().uuid();
const control = { lease, session_id: session };

function tool(name, description, inputSchema, annotations) {
  const localized = localizeDescription(name, description, language);
  toolCatalog.set(name, { name, description: localized, execution: "bridge", parameters: Object.keys(inputSchema) });
  server.registerTool(name, { description: localized, inputSchema, ...(annotations && { annotations }) }, async (args) => {
    let result;
    try {
      result = await request(name, args);
    } catch (error) {
      const offline = error.code === "bridge_offline";
      result = {
        ok: false,
        ready: false,
        code: bridgeErrors.has(error.code) ? error.code : "transport_error",
        message: offline
          ? (steamMode
            ? "Launch Infection Free Zone from Steam with the IFZ MCP plugin installed."
            : "Start the instrumented IFZ test copy with scripts/Start-TestGame.ps1.")
          : error.message,
      };
    }
    return {
      isError: !result.ok && !(name === "status" && result.code === "bridge_offline"),
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  });
}

function writeTool(name, description, inputSchema) {
  if (!readOnly) tool(name, description, inputSchema);
}

// 本地工具：不经桥接，直接读本地文件（天气来自存档 data.json）。
function localTool(name, description, inputSchema, handler, annotations) {
  const localized = localizeDescription(name, description, language);
  toolCatalog.set(name, { name, description: localized, execution: "composite_or_local", parameters: Object.keys(inputSchema) });
  server.registerTool(name, { description: localized, inputSchema, ...(annotations && { annotations }) }, async (args) => {
    let result;
    try {
      result = await handler(args);
    } catch (error) {
      result = { ok: false, code: typeof error.code === "string" ? error.code : "tool_error", message: error.message };
    }
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  });
}

tool("status", "Check whether the configured IFZ game and its current settlement are ready.", {});
tool("get_state", "Read time, pause reasons, HQ, player squads and the last bounded advance.", {});
tool("get_current_weather", "Read live weather and current air temperature in Celsius from the loaded settlement, including cloud cover, precipitation, wind and moon conditions.", { session_id: session });
tool("get_mood", "Read the settlement's current civilian mood, trend, visible contributing factors, and effects on worker efficiency and birth rate.", { session_id: session });
tool("get_active_dialogue", "Read the visible radio conversation, selectable replies and the effects listed by the game. A null dialogue means no radio conversation is currently open.", { session_id: session });
writeTool("choose_dialogue_option", "Select a reply in the current radio conversation using the latest choice_id and option_id. Acquire the write lease and reuse request_id on retry. The game applies the reply and its own pause rules.", { ...dialogueChoiceInput, lease });
writeTool("hud_message", "Show a short message on the in-game HUD overlay so the player can read AI updates and alerts without leaving the game.", {
  text: z.string().trim().min(1).max(500),
  seconds: z.number().int().min(3).max(3600).optional(),
});
const worldPage = {
  session_id: session,
  offset: z.number().int().min(0).max(2147483647).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
tool("get_world_data", "Read a page from live game objects across the map. Nonplayer groups include hidden groups. Use get_map_buildings for building details.", {
  ...worldPage,
  category: z.enum(["squads", "citizens", "workers", "groups", "virtual_groups",
    "worksites", "vehicles", "stockrooms", "ground_resources", "stockpile", "resource_types", "map", "weapons", "events"]),
});

// Settlement intelligence requires the plugin build containing SettlementIntel.cs.
tool("get_research_status", "Read live technology and legacy law research progress, current scientists and scientific materials. Native research work units are not game hours.", { session_id: session }, readAnnotations);
tool("get_research_catalog", "Page live technology or legacy law research definitions with state, costs, prerequisites and progress. This does not select or start research.", {
  ...worldPage, group: z.enum(["technology", "law"]).optional(),
  state: z.enum(["locked", "unlocked", "being_researched", "completed", "unavailable"]).optional(),
}, readAnnotations);
tool("get_laws", "Read modern settlement laws, selected options, unlocked law groups, assembly state and native food/work-hour modifiers. Does not enact laws.", { session_id: session }, readAnnotations);
tool("get_housing", "Read native housing capacity, occupied beds, homeless counts and a page of housing structures.", worldPage, readAnnotations);
tool("get_storage_capacity", "Read shared physical/virtual storage capacity, occupied/reserved space and each warehouse's capacity contribution. Warehouses share inventory; individual stock quantities are not inferred.", worldPage, readAnnotations);
tool("get_population_health", "Read living citizens and squad members' sickness, treatment, hunger and fatigue with deduplicated population totals and paginated individual details.", worldPage, readAnnotations);
tool("get_food_status", "Read edible ration/can stocks, raw ingredients, food consumption settings and spoilage buckets; any daily consumption estimate includes its assumptions.", { session_id: session }, readAnnotations);
tool("get_resource_definitions", "Page the native resource definitions: translated names, types, crate quantities, trade values and dismantling yields. This catalog does not change inventory.", {
  ...worldPage, resource_id: z.string().min(1).max(64).optional(),
}, readAnnotations);
tool("get_resource_flows", "Page native production, scavenging and resource removal-request counters for the current and previous game day. Used includes failed removal requests; tracked net is not actual consumption or inventory delta.", {
  ...worldPage, resource_id: z.string().min(1).max(64).optional(),
}, readAnnotations);

// NPC zones and convoy destinations share location types, but use different coordinate spaces.
const npcPage = { ...worldPage, include_hidden: z.boolean().optional().describe("Include undiscovered entities without revealing them in the game (default false)") };
tool("get_npc_zone", "Read the current map's NPC zone type, discovery/takeover state and population/building summary. Does not reveal, claim or provoke the settlement.", {
  session_id: session, include_hidden: npcPage.include_hidden,
}, readAnnotations);
tool("get_npc_zone_groups", "Page only groups tagged NpcZoneGroup, with true affiliation to the player, immigration/dialogue state and native attackability. Ordinary passing immigrants are excluded. Hidden groups are excluded by default.", npcPage, readAnnotations);
tool("get_npc_zone_structures", "Page the buildings and structures belonging to the current NPC zone, including ownership, condition and position. Uses zone discovery, not current per-building line of sight; undiscovered zone details require include_hidden. Does not adapt or take over buildings.", npcPage, readAnnotations);
tool("get_group_relations", "Read actual player affiliation for physical groups: Own, Hostile, Neutral or Indifferent. Visibility and attackability are separate fields; false hostile_to_player alone does not establish neutrality.", {
  ...npcPage, group_id: z.string().min(1).max(64).optional(),
}, readAnnotations);
tool("get_convoy_locations", "Page already-cached convoy destination types and known names with geographic tile coordinates and visited status. These coordinates are not settlement X/Z. Does not generate destinations or load a new map.", {
  ...worldPage,
  location_type: z.enum(["NormalPlace", "NeutralZone", "FarmersZone", "RaidersCamp", "NuclearZone", "QuietPlace", "AbandonedZone", "MilitaryZone", "PurifiersZone"]).optional(),
  include_unrevealed: z.boolean().optional().describe("Include unnamed/unregistered destinations already in the cache (default false); does not discover them in-game"),
}, readAnnotations);
tool("get_convoy_status", "Page saved visited regions with current convoy context and live player squad/vehicle/cargo totals. The native IsConvoyStart flag means a special starting scenario, not departure in progress. Historical departure manifests remain unknown; no convoy is loaded or moved.", worldPage, readAnnotations);
tool("get_workforce", "Read the current worker management mode, available civilian workers and one page of active staffing tasks, including buildings and gathering areas. Each task includes the actual assignment count, capacity, vacancies, work status and priority. Use next_offset to page.", worldPage);
const entityId = z.string().min(1).max(64);
tool("get_squad_experience", "Read each living squad member's shooting, melee, scavenging and driving experience, activated skills, current weapon and effective range. Omit squad_id to list all player squads.", {
  session_id: session,
  squad_id: entityId.optional(),
});
tool("get_weapon_details", "Read the game's weapon catalog, including base settlement and expedition ranges, close range, tooltip damage values, attack cooldown, ammunition and use restrictions. Omit weapon_id to list the catalog.", {
  session_id: session,
  weapon_id: entityId.optional(),
});
tool("get_attack_conditions", "For one squad and a visible hostile group, read each member's current distance, effective range, line of sight, ammo and cooldown. Virtual combat has no local firing checks.", {
  session_id: session,
  squad_id: z.string().min(1).max(64),
  group_id: z.string().min(1).max(64),
  virtual: z.boolean().optional(),
});
const coordinate = z.number().finite();
const point = { x: coordinate, z: coordinate };
const constructionPlan = {
  session_id: session,
  kind: z.enum(["new", "adapt"]),
  type_id: entityId,
  building_id: entityId.optional().describe("Required for adapt. Use an existing building ID from get_map_buildings."),
  x: coordinate.optional(), z: coordinate.optional(),
  width_m: z.number().positive().max(1000).optional(),
  length_m: z.number().positive().max(1000).optional(),
  height_m: z.number().positive().max(1000).optional(),
  rotation_degrees: z.number().min(-360).max(360).optional(),
  facade: z.enum(["wood", "wood_only", "bricks", "plaster", "cementBlocks", "stone", "metal", "metal_only"]).optional(),
  max_distance_to_owned_m: z.number().finite().positive().optional().describe("Placement limit from nearest owned building, default 200 m."),
  production_workers: z.number().int().nonnegative().max(2147483647).optional().describe("Staffing scenario for the time estimate, default full capacity."),
};
tool("get_construction_catalog", "Read building types, technology unlocks, shape limits, minimum clearance and the available recipe IDs for each type.", { session_id: session });
tool("preview_construction", "Check the placement and estimate costs, worker capacity, and active in-game hours per production cycle. For new, provide x, z, width_m, length_m and height_m. For adapt, provide building_id. Check valid and blockers before submitting.", constructionPlan);
tool("get_construction_order", "Check a submitted construction request. queued means the native construction job exists; monitor workforce for staffing and building_info for completion.", { session_id: session, request_id: orderId });
tool("get_facilities", "List completed production, defense, or healthcare facilities. Shows selectable recipes or weapons, assigned staff and the workforce task ID. Healthcare also reports treatment beds and healing. Filter with structure_id for one facility.", {
  ...worldPage,
  category: z.enum(["production", "defense", "healthcare"]),
  structure_id: entityId.optional(),
});
tool("get_fog_of_war", "Sample settlement sight coverage from the game's active observers and sight radii. This is a read-only estimate. Defaults to full map bounds; for local detail provide a rectangle within get_map_info bounds.", {
  session_id: session,
  min_x: coordinate.optional(), max_x: coordinate.optional(),
  min_z: coordinate.optional(), max_z: coordinate.optional(),
  columns: z.number().int().min(1).max(64).optional(),
  rows: z.number().int().min(1).max(64).optional(),
});
registerMapQuery(tool, worldPage);
tool("get_navigation_point", "Project a world point onto the game's walkable ground mesh and read its height and area.", {
  session_id: session,
  ...point,
  y: coordinate,
});
tool("get_terrain_grid", "Sample the game's navigation graph into a terrain grid in one call: walkability, water, roads, building interiors, bridge candidates and optional ground heights. Much faster than repeated get_navigation_point calls (needs plugin 0.2).", {
  session_id: session,
  step: z.number().min(1).max(300).optional().describe("Grid step in world units (default 50)"),
  min_x: coordinate.optional(),
  min_z: coordinate.optional(),
  max_x: coordinate.optional(),
  max_z: coordinate.optional(),
  include_heights: z.boolean().optional().describe("Also return per-cell ground height rows"),
  include_surface_water: z.boolean().optional().describe("Also check the actual map water surface, including under buildings"),
  max_cells: z.number().int().min(100).max(60000).optional().describe("Safety cap for cols*rows (default 20000)"),
});
if (allowWorkforceWrites) {
  tool("acquire_control", "Claim the shared write lease or renew it by passing the existing token.", {
    owner: z.string().trim().min(1).max(40),
    lease: lease.optional(),
  });
  tool("release_control", "Release the shared write lease.", { lease });
}
writeTool("pause", "Apply gameplay pause without dismissing popups.", {
  ...control, pause_request_id: orderId.optional().describe("Track a temporary co-op pause owned by this lease."),
});
const stockQuantity = z.number().finite().min(0).max(1000000);
writeTool("set_stockpile_amount", "Set a supported resource in the shared stockpile while paused. Read resource_types for editable IDs and pass the current quantity as expected_amount.", {
  ...control,
  resource_id: entityId,
  expected_amount: stockQuantity,
  amount: stockQuantity,
});
const worldCommand = { ...control, request_id: z.string().uuid() };
if (allowConstruction) {
  tool("queue_construction", "Queue one native civilian construction or adaptation job from a valid preview. Rechecks placement, unlocks and proximity. Pass the same plan as preview_construction, with a lease and request_id. Reuse the request ID on retry and read get_construction_order for the receipt.", {
    ...constructionPlan, ...worldCommand,
  });
  tool("set_facility_production", "Select an unlocked recipe at one production facility, including hospital recipes when applicable. In-progress batches finish before switching. Pass current_recipe_id and next_recipe_id from get_facilities as the expected values, using null for an empty selection.", {
    ...worldCommand,
    structure_id: entityId,
    recipe_id: entityId,
    expected_current_recipe_id: entityId.nullable(),
    expected_next_recipe_id: entityId.nullable(),
  });
  tool("set_facility_defense_weapon", "Select one allowed weapon for a completed defense structure such as a gate or tower. Guards use normal stockpile logistics. Use get_facilities defense to read allowed weapons and the expected current selection.", {
    ...worldCommand,
    structure_id: entityId,
    weapon_id: entityId,
    expected_weapon_id: entityId.nullable(),
  });
}
if (allowWorkforceWrites) {
  const workerValue = z.number().int().nonnegative().max(2147483647);
  tool("update_work_task", "Adjust one civilian work task using the game's native staffing controls. Read get_workforce first. In manual mode set assigned_workers; in priorities mode set max_workers or priority (1–5). Pass the previous value as expected_value. Read the returned task for actual staffing and reuse request_id on retry.", {
    ...worldCommand,
    mode: z.enum(["manual", "priorities"]),
    task_id: entityId,
    setting: z.enum(["assigned_workers", "max_workers", "priority"]),
    expected_value: workerValue,
    value: workerValue,
  });
}
const replaceOrders = z.boolean().optional();
writeTool("move_squad", "Queue a native move 6–100 world units away. Set replace_orders to override existing orders or move a vehicle. Pause first. Retry with the same request_id.", {
  ...worldCommand,
  squad_id: entityId,
  ...point,
  replace_orders: replaceOrders,
});
writeTool("cancel_squad_order", "Cancel a specific tracked native squad order by its original request ID. Preserves other queued orders and the current game speed. Reuse the cancellation request_id on retry.", {
  ...control,
  squad_id: z.string().min(1).max(64),
  order_id: orderId,
  request_id: orderId,
});
writeTool("move_npc_group", "Submit a native movement target for a nonplayer group. NPC AI may choose another target after simulation resumes.", {
  ...worldCommand,
  group_id: entityId,
  virtual: z.boolean().optional(),
  ...point,
});
writeTool("attack_group", "Queue a native attack on a visible hostile group. Read the squad's active and queued orders to follow it.", {
  ...worldCommand,
  squad_id: entityId,
  group_id: entityId,
  virtual: z.boolean().optional(),
  replace_orders: replaceOrders,
});
writeTool("scavenge_building", "Send a squad to enter and scavenge a building that can be scavenged.", {
  ...worldCommand,
  squad_id: entityId,
  building_id: entityId,
  replace_orders: replaceOrders,
});
writeTool("return_to_stockroom", "Order a squad into a shared stockroom or headquarters. Aboard a vehicle the game unloads the trunk on arrival; a walking squad enters on foot and deposits carried resources. Omit stockroom_id to return to headquarters.", {
  ...worldCommand,
  squad_id: entityId,
  vehicle_id: entityId.optional(),
  stockroom_id: entityId.optional(),
  replace_orders: replaceOrders,
});
writeTool("take_vehicle", "Order a walking squad to reach a discovered abandoned vehicle and take it over. The squad walks there and boards natively; read squads and vehicles afterwards to confirm the owner change.", {
  ...worldCommand,
  squad_id: entityId,
  vehicle_id: entityId,
  replace_orders: replaceOrders,
});
writeTool("set_building_workers", "Change a building job's worker limit using the same setter as the game. Read worksites for assigned workers and valid limits.", {
  ...worldCommand,
  building_id: entityId,
  expected_max_workers: z.number().int().nonnegative().max(2147483647),
  max_workers: z.number().int().nonnegative().max(2147483647),
});
const memberEquipment = {
  ...worldCommand,
  squad_id: entityId,
  member_id: entityId,
  source: z.enum(["cargo", "stockpile"]),
};
writeTool("equip_squad_member", "Equip an existing weapon from squad cargo or stockpile. Uses one weapon and drops the previous non-default weapon via the native handler.", {
  ...memberEquipment,
  weapon_id: entityId,
});
writeTool("refill_squad_member_ammo", "Refill a member's weapon from matching ammunition in the chosen container.", memberEquipment);
tool("get_order", "Inspect the result of a move. Read position and target to verify arrival.", {
  session_id: session,
  order_id: orderId,
});
writeTool("advance", "Run the simulation at normal speed for at most 1–12 wall-clock seconds. Poll get_state. The bridge reapplies gameplay pause at the deadline unless keep_running is set. Background advance requires Unity to run in the background and explicit allow_background.", {
  ...control,
  seconds: z.number().int().min(1).max(12),
  until_order_id: orderId.optional(),
  pause_request_id: orderId.optional().describe("Resume only if this co-op pause still owns gameplay pause."),
  allow_background: z.boolean().optional(),
  keep_running: z.boolean().optional().describe("Leave the game at normal 1x speed when the bounded window ends or the tracked order finishes. Use it while cooperating with a player who plays at 1x."),
});

// 作弊/调试工具（插件 0.2 起提供，封装游戏自带 GameConsoleCommandHandler）。
tool("get_building_info", "Read one building: type, state, scavenge flags, resource icons (Gun/Fuel/Drugs/Tools/Metal/Warehouse...), and loot details when a squad has already entered it (scavenge progress + remaining crates).", {
  session_id: session,
  building_id: entityId,
});
tool("get_building_details", "Read everything one building exposes in a single call: identity, state, position/bounds, POI icons, storage contents, scavenge progress, production batch progress, defense weapon/guards, healthcare data, related staffing tasks, and an optional reflection dump that surfaces hidden numeric fields such as remaining deposit/resource amounts.", {
  session_id: session,
  building_id: entityId,
  include_reflection: z.boolean().optional().describe("Dump public scalar properties and the structure's own fields to reveal hidden numbers like remaining deposit amount (default true)"),
});
tool("get_production_progress", "Summarize every production facility: current recipe, batch progress 0-1, estimated remaining game hours, staffing, per-cycle inputs/outputs, and whether missing stockpile inputs are blocking the batch.", { session_id: session });
tool("get_scavenge_progress", "List every in-progress scavenge: progress 0-1, time left, remaining loot crates and characters inside.", {
  session_id: session,
  limit: z.number().int().min(1).max(200).optional(),
});
tool("find_buildings_by_poi", "Find buildings by map resource icon: pass POI archetypes such as [\"Gun\",\"Fuel\",\"Drugs\",\"Metal\"]. Uses the same OSM tag rules as the in-game icons.", {
  session_id: session,
  poi: z.array(z.string().min(1).max(30)).min(1).max(6),
  radius: z.number().min(50).max(6000).optional().describe("Radius from HQ (default 2500)"),
  x: coordinate.optional(),
  z: coordinate.optional(),
  limit: z.number().int().min(1).max(300).optional(),
  only_scavengeable: z.boolean().optional().describe("Only un-scavenged scavengeable buildings (default true)"),
});

tool("get_missions", "Detailed active missions: title key, chapter, time limit and per-objective progress (kill counts, hideout counts, buildings visited). Optionally list all objective types.", {
  session_id: session,
  include_types: z.boolean().optional().describe("Also return the full ObjectiveType enum list"),
});
tool("get_expedition_tiles", "List loaded expedition tiles: area/location type, resource icons (Gun/Fuel/Drugs...), scavengable state, scavenge progress and collected resources. Open the world map in-game first so tiles load.", {
  session_id: session,
  radius: z.number().min(0).max(6000).optional().describe("Radius from HQ in world units (0 = all)"),
  only_scavengable: z.boolean().optional(),
  limit: z.number().int().min(1).max(400).optional(),
});
tool("get_vehicle_map", "List every vehicle on the map including undiscovered wrecks (get_world_data only shows discovered/owned ones), with type, state, fuel, cargo and distance to HQ.", {
  session_id: session,
  include_undiscovered: z.boolean().optional(),
  radius: z.number().min(0).max(6000).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

if (enableCheats) {
  registerCheatTools({ registerLocal: localTool, request });
} else if (!readOnly) {
  writeTool("cheat_list", "List the available cheat/debug bridge methods and their arguments. Requires the write lease.", control);
  writeTool("cheat_heal_squads", "Heal every member of the player's squads back to full health (keeps current max HP). Requires the write lease.", control);
  writeTool("cheat_refill_ammo", "Refill the ammunition of every weapon carried by the player's squads. Requires the write lease.", control);
  writeTool("cheat_add_resources", "Add resources straight into the shared stockpile, bypassing scavenging. Requires the write lease.", {
    ...control,
    resource_id: entityId.describe("Exact ResourceID name, e.g. res_metal, res_bricks, res_drugs, res_ammo, eq_assault_rifle"),
    quantity: z.number().finite().positive().max(1000000).optional().describe("Amount to add (default 100)"),
  });
  writeTool("cheat_unlock_expedition", "Unlock every expedition tile on the world map. Requires the write lease.", control);
  writeTool("cheat_complete_missions", "Immediately complete all active missions and their objectives (story progression shortcut). Requires the write lease.", control);
  writeTool("cheat_scavenge_all", "Mark every abandoned building on the map as scavenged in one step. Requires the write lease.", control);
  writeTool("cheat_set_time", "Set the in-game day/hour or the time-speed multiplier. Requires the write lease.", {
    ...control,
    day: z.number().int().min(1).max(10000).optional(),
    hour: z.number().int().min(0).max(23).optional(),
    speed: z.number().finite().min(0).max(100).optional(),
  });
  writeTool("cheat_spawn_squad", "Spawn a new player squad at a walkable position. Requires the write lease.", {
    ...control,
    ...point,
    count: z.number().int().min(1).max(12).optional().describe("Member count (default 4)"),
    vehicle: entityId.optional().describe("Exact VehicleType name, e.g. ve_sedan, ve_pickup (default ve_sedan)"),
  });
  writeTool("cheat_reveal_groups", "Reveal every hostile group on the map, including hidden ones. Requires the write lease.", control);
  writeTool("cheat_complete_mission", "Complete the objectives of ONE active mission (by mission_id). Safer than cheat_complete_missions which finishes everything. Requires the write lease.", {
    ...control,
    mission_id: entityId.describe("Mission id from get_missions / get_world_data(events)"),
  });
}

localTool("get_weather", "Read weather, moon phase and forecast from the newest save file. Use get_current_weather for the loaded settlement's live conditions and temperature.", {
  save_root: z.string().min(1).optional().describe("Save root directory; omit to auto-detect the Steam or test save root"),
  all_forecast: z.boolean().optional().describe("Include the whole 38-day forecast in the reply"),
}, async (args) => getWeather({ saveRoot: args.save_root ?? null }));

// 复合/本地聚合工具：组合现有桥接调用，无需插件改动
registerExtraTools({ registerLocal: localTool, request, readOnly });
registerMoreTools({ registerLocal: localTool, request, readOnly });
registerEnemyTools({ registerLocal: localTool, request, readOnly });
registerTools4({ registerLocal: localTool, request, readOnly });
const registerRead = (name, description, schema, handler) => localTool(name, description, schema, handler, readAnnotations);
registerLogisticsTools({ registerLocal: registerRead, request });
registerOperationsTools({ registerLocal: registerRead, request });
registerTacticalTools({ registerLocal: registerRead, request });
registerRead("get_tool_catalog", "Search the tools enabled in this MCP process by name or description; returns parameter names and bridge/local routing. Available offline. This lists registrations, not installed plugin compatibility.", {
  query: z.string().trim().max(100).optional(),
  offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(),
}, async ({ query = "", offset = 0, limit = 30 }) => {
  const needle = query.toLowerCase();
  const items = [...toolCatalog.values()].filter(t => `${t.name} ${t.description}`.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, mode: strictReadOnly ? "read_only" : workforceOnly ? "workforce" : "default",
    total: items.length, offset, next_offset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) };
});

await server.connect(new StdioServerTransport());
