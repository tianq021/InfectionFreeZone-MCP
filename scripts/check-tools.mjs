import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "ifz-tool-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../server.mjs", import.meta.url))],
});

try {
  await client.connect(transport);
  if (process.argv.includes("--call")) {
    for (const name of ["get_save_info", "observe"]) {
      const result = await client.callTool({ name, arguments: {} });
      const data = result.structuredContent;
      if (typeof data?.ok !== "boolean") {
        throw new Error(`Unexpected result from ${name}`);
      }
      console.log(JSON.stringify({ name, ok: data.ok, code: data.code }));
    }
  } else {
    const { tools } = await client.listTools();
    const names = tools.map(({ name }) => name).sort();
    console.log(JSON.stringify({ count: names.length, names }, null, 2));
  }
} finally {
  await client.close();
}
