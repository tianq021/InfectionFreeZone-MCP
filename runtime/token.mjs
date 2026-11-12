import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function runtimeToken({ create = false } = {}) {
  const configured = process.env.IFZ_RUNTIME_TOKEN?.trim();
  const path = process.env.IFZ_RUNTIME_TOKEN_FILE ??
    join(process.env.LOCALAPPDATA ?? homedir(), "ifz-runtime", "token");
  let token = configured;
  if (!token) {
    try {
      token = readFileSync(path, "utf8").trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return undefined;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      token = randomBytes(32).toString("hex");
      try {
        writeFileSync(path, token + "\n", { mode: 0o600, flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        token = readFileSync(path, "utf8").trim();
      }
    }
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Invalid IFZ Runtime token.");
  return token;
}

export function runtimeHeaders(headers = {}) {
  const token = runtimeToken();
  return token ? { ...headers, "x-ifz-token": token } : headers;
}
