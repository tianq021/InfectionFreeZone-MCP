import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const added = [
  "get_research_status", "get_research_catalog", "get_laws", "get_housing", "get_storage_capacity",
  "get_population_health", "get_food_status", "get_resource_definitions", "get_resource_flows",
  "get_stockpile_report", "get_resource_locations", "get_storage_report", "get_ground_resources_report",
  "get_resource_catalog", "get_resource_budget", "get_supply_network", "get_cargo_manifest",
  "get_production_bottlenecks", "get_recipe_catalog", "get_production_capacity", "get_healthcare_report",
  "get_defense_report", "get_workforce_plan", "get_construction_queue", "get_settlement_alerts",
  "get_squad_readiness", "get_wounded_report", "get_ammo_supply_report", "get_nearby_entities",
  "get_return_options", "get_mission_deadlines", "get_tool_catalog",
  "get_npc_zone", "get_npc_zone_groups", "get_npc_zone_structures", "get_group_relations",
  "get_convoy_locations", "get_convoy_status",
];

for (const flags of [[], ["--read-only"], ["--workforce-only", "--allow-construction"]]) {
  test(`expanded tools are available and annotated: ${flags.join(" ") || "default"}`, async t => {
    const client = new Client({ name: "expanded-tools-test", version: "1.0" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../../server.mjs", import.meta.url)), ...flags], stderr: "pipe" });
    t.after(() => client.close());
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    assert.equal(names.size, tools.length);
    for (const name of added) {
      const tool = tools.find(tool => tool.name === name);
      assert.ok(tool, `Missing ${name}`);
      assert.equal(tool.annotations?.readOnlyHint, true, name);
      assert.equal(tool.annotations?.openWorldHint, false, name);
    }
    if (flags.includes("--read-only")) {
      for (const name of ["acquire_control", "update_work_task", "queue_construction", "cheat_add_resources", "move_squad"]) assert.ok(!names.has(name), name);
    }
    const catalog = await client.callTool({ name: "get_tool_catalog", arguments: { limit: 100 } });
    assert.equal(catalog.isError, false);
    assert.equal(catalog.structuredContent.total, tools.length);
    assert.equal(catalog.structuredContent.items.length, Math.min(100, tools.length));
    const search = await client.callTool({ name: "get_tool_catalog", arguments: { query: "get_research_catalog" } });
    assert.deepEqual(search.structuredContent.items.map(row => row.name), ["get_research_catalog"]);
    const invalid = await client.callTool({ name: "get_nearby_entities", arguments: { x: 0, z: 0, radius: -1 } });
    assert.equal(invalid.isError, true);
    const session_id = "00000000-0000-4000-8000-000000000000";
    for (const [name, args] of [
      ["get_npc_zone", { session_id: "not-a-session" }],
      ["get_npc_zone_groups", { session_id, limit: 101 }],
      ["get_npc_zone_structures", { session_id, include_hidden: "true" }],
      ["get_group_relations", { session_id, group_id: "" }],
      ["get_convoy_locations", { session_id, location_type: "NotAZone" }],
      ["get_convoy_status", {}],
    ]) {
      const response = await client.callTool({ name, arguments: args });
      assert.equal(response.isError, true, name);
      // Schema failures must be rejected before any game bridge request.
      assert.match(response.content[0].text, /validation|invalid|expected|required/i, name);
    }
  });
}
