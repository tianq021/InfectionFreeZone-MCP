import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerMapQuery } from "./map-query.mjs";
import { getWeather } from "./weather.mjs";
import { registerExtraTools } from "./tools-extra.mjs";
import { registerMoreTools } from "./tools-extra2.mjs";
import { registerEnemyTools } from "./tools-extra3.mjs";
import { registerTools4 } from "./tools-extra4.mjs";
import { dialogueChoiceInput } from "./runtime/dialogue.mjs";
import { localizeDescription, resolveLanguage, LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "./i18n.mjs";

const language = resolveLanguage();
const steamMode = process.argv.includes("--steam");
const readOnly = process.argv.includes("--read-only");
const pipePath = steamMode
  ? "\\\\.\\pipe\\infection-free-zone-mcp-steam-v1"
  : "\\\\.\\pipe\\infection-free-zone-mcp-v1";
const maxResponseSize = 1024 * 1024;
const server = new McpServer({ name: "infection-free-zone", version: "0.2.2" });
process.stderr.write(`[ifz-mcp] language=${language} (${LANGUAGE_LABELS[language] ?? language}); supported=${SUPPORTED_LANGUAGES.join(",")}\n`);

async function request(method, args) {
  const body = Buffer.from(JSON.stringify({ method, args }), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  const socket = net.createConnection(pipePath);
  socket.setTimeout(5000, () => socket.destroy(new Error("Pipe response timed out")));
  try {
    socket.on("connect", () => socket.write(Buffer.concat([header, body])));
    let received = Buffer.alloc(0);
    let expectedSize;
    for await (const chunk of socket) {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) continue;
      expectedSize ??= received.readUInt32LE(0);
      if (!expectedSize || expectedSize > maxResponseSize) {
        throw new Error("Invalid bridge response length");
      }
      if (received.length >= expectedSize + 4) {
        return JSON.parse(received.subarray(4, expectedSize + 4).toString("utf8"));
      }
    }
    throw new Error("Bridge closed before replying");
  } finally {
    socket.destroy();
  }
}

const lease = z.string().uuid().describe("Token returned by acquire_control");
const session = z.string().uuid().describe("Current session_id from get_state");
const orderId = z.string().uuid();
const control = { lease, session_id: session };

function tool(name, description, inputSchema) {
  const localized = localizeDescription(name, description, language);
  server.registerTool(name, { description: localized, inputSchema }, async (args) => {
    let result;
    try {
      result = await request(name, args);
    } catch (error) {
      const offline = error.code === "ENOENT" || error.code === "ECONNREFUSED";
      result = {
        ok: false,
        ready: false,
        code: offline ? "bridge_offline" : "transport_error",
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
function localTool(name, description, inputSchema, handler) {
  const localized = localizeDescription(name, description, language);
  server.registerTool(name, { description: localized, inputSchema }, async (args) => {
    let result;
    try {
      result = await handler(args);
    } catch (error) {
      result = { ok: false, code: "tool_error", message: error.message };
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
const entityId = z.string().min(1).max(64);
const coordinate = z.number().finite();
const point = { x: coordinate, z: coordinate };
registerMapQuery(tool, worldPage);
tool("get_navigation_point", "Project a world point onto the game's walkable ground mesh and read its height and area.", {
  session_id: session,
  ...point,
  y: coordinate,
});
tool("get_terrain_grid", "Sample the game's navigation graph into a terrain grid in one call: walkability, water, roads, building interiors, bridge candidates and optional ground heights. Much faster than repeated get_navigation_point calls (needs plugin 0.2).", {
  session_id: session,
  step: z.number().min(5).max(300).optional().describe("Grid step in world units (default 50)"),
  min_x: coordinate.optional(),
  min_z: coordinate.optional(),
  max_x: coordinate.optional(),
  max_z: coordinate.optional(),
  include_heights: z.boolean().optional().describe("Also return per-cell ground height rows"),
  max_cells: z.number().int().min(100).max(60000).optional().describe("Safety cap for cols*rows (default 20000)"),
});
writeTool("acquire_control", "Claim the shared write lease or renew it by passing the existing token.", {
  owner: z.string().trim().min(1).max(40),
  lease: lease.optional(),
});
writeTool("release_control", "Pause any active advance and release the write lease.", { lease });
writeTool("pause", "Apply gameplay pause without dismissing popups.", control);
const stockQuantity = z.number().finite().min(0).max(1000000);
writeTool("set_stockpile_amount", "Set a supported resource in the shared stockpile while paused. Read resource_types for editable IDs and pass the current quantity as expected_amount.", {
  ...control,
  resource_id: entityId,
  expected_amount: stockQuantity,
  amount: stockQuantity,
});
const worldCommand = { ...control, request_id: z.string().uuid() };
const replaceOrders = z.boolean().optional();
writeTool("move_squad", "Queue a native move 6–100 world units away. Set replace_orders to override existing orders or move a vehicle. Pause first. Retry with the same request_id.", {
  ...worldCommand,
  squad_id: entityId,
  ...point,
  replace_orders: replaceOrders,
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
  allow_background: z.boolean().optional(),
  keep_running: z.boolean().optional().describe("Leave the game at normal 1x speed when the bounded window ends or the tracked order finishes. Use it while cooperating with a player who plays at 1x."),
});

// 作弊/调试工具（插件 0.2 起提供，封装游戏自带 GameConsoleCommandHandler）。
tool("get_building_info", "Read one building: type, state, scavenge flags, resource icons (Gun/Fuel/Drugs/Tools/Metal/Warehouse...), and loot details when a squad has already entered it (scavenge progress + remaining crates).", {
  session_id: session,
  building_id: entityId,
});
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

localTool("get_weather", "Read current weather, moon phase and the 38-day forecast from the newest save file. The bridge has no weather endpoint, so this reads on-disk save data and may lag by up to one in-game day. A full moon night usually brings a large horde.", {
  save_root: z.string().min(1).optional().describe("Save root directory; omit to auto-detect the Steam or test save root"),
  all_forecast: z.boolean().optional().describe("Include the whole 38-day forecast in the reply"),
}, async (args) => getWeather({ saveRoot: args.save_root ?? null }));

// 复合/本地聚合工具：组合现有桥接调用，无需插件改动
registerExtraTools({ registerLocal: localTool, request, readOnly });
registerMoreTools({ registerLocal: localTool, request, readOnly });
registerEnemyTools({ registerLocal: localTool, request, readOnly });
registerTools4({ registerLocal: localTool, request, readOnly });

await server.connect(new StdioServerTransport());
