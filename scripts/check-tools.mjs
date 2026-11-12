import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values } = parseArgs({ options: {
  call: { type: "boolean" },
  steam: { type: "boolean" },
  "read-only": { type: "boolean" },
  "workforce-only": { type: "boolean" },
  "allow-construction": { type: "boolean" },
  "enable-cheats": { type: "boolean" },
} });
const modeArgs = ["steam", "read-only", "workforce-only", "allow-construction", "enable-cheats"]
  .filter((flag) => values[flag]).map((flag) => "--" + flag);
const client = new Client({ name: "ifz-tool-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../server.mjs", import.meta.url)), ...modeArgs],
});

try {
  await client.connect(transport);
  if (values.call) {
    let sessionId;
    const calls = ["status", "get_state", "get_active_dialogue", "get_save_info", "observe"];
    if (values["workforce-only"]) calls.push("get_workforce", "get_fog_of_war");
    const sessionTools = new Set(["get_active_dialogue", "get_workforce", "get_fog_of_war"]);
    for (const name of calls) {
      const args = sessionTools.has(name) ? { session_id: sessionId } : {};
      const result = await client.callTool({ name, arguments: args });
      const data = result.structuredContent;
      console.log(JSON.stringify({
        name, ok: data?.ok, ready: data?.ready, code: data?.code, plugin_build_id: data?.plugin_build_id,
        ...(name === "get_workforce" && { mode: data?.mode, available_workers: data?.available_workers, tasks: data?.total }),
        ...(name === "get_fog_of_war" && { covered_samples: data?.covered_samples, fogged_samples: data?.fogged_samples }),
      }));
      const needsSettlement = name === "status" || name === "get_state";
      if (result.isError || data?.ok !== true || (needsSettlement && (data.ready !== true || !data.session_id))) {
        console.error(`${name}: ${data?.message ?? "Live settlement check failed."}`);
        process.exitCode = 1;
        break;
      }
      if (name === "get_state") sessionId = data.session_id;
    }
  } else {
    const { tools } = await client.listTools();
    const names = tools.map(({ name }) => name).sort();
    console.log(JSON.stringify({ count: names.length, names }, null, 2));
  }
} finally {
  await client.close();
}
