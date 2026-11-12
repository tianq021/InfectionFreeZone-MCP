import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runCoop } from "./coop.mjs";

const cliArgs = process.argv.slice(2);
const steamMode = cliArgs[0] === "--steam";
const [tool = "status", ...toolArgs] = steamMode ? cliArgs.slice(1) : cliArgs;
const input = toolArgs[0] ?? "{}";
const workflow = tool === "coop" ? runCoop : null;
const args = workflow ? null :
  JSON.parse(input.startsWith("@") ? await readFile(input.slice(1), "utf8") : input);
const client = new Client({ name: "ifz-mcp-client", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.mjs", import.meta.url)), ...(steamMode ? ["--steam"] : [])],
  stderr: "inherit",
});

try {
  await client.connect(transport);
  if (workflow) {
    const call = async (name, parameters) => {
      const response = await client.callTool({ name, arguments: parameters });
      const value = response.structuredContent ?? JSON.parse(response.content[0].text);
      if (response.isError || value.ok === false) {
        throw Object.assign(new Error(value.message ?? name), { code: value.code });
      }
      return value;
    };
    let result;
    try {
      result = await workflow(toolArgs, call);
    } catch (error) {
      result = { ok: false, error: { code: error.code, message: error.message } };
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } else {
    const result = tool === "list"
      ? await client.listTools()
      : await client.callTool({ name: tool, arguments: args });
    console.log(JSON.stringify(result.structuredContent ?? result, null, 2));
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
