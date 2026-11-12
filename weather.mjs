// 天气 / 月相查询：直接读取最近一次存档里的 WeatherControllerSerialized。
//
// 用法：
//   node weather.mjs               人类可读摘要
//   node weather.mjs --json        JSON 输出
//   node weather.mjs --save-root "<存档根目录>"
//   node weather.mjs --all-forecast 打印全部 38 天预报
//
// 此脚本读取磁盘存档。运行中的天气和气温由 MCP 的 get_current_weather 查询。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const STEAM_SAVE_ROOT = "C:\\Users\\hp\\AppData\\LocalLow\\JutsuGames\\Infection Free Zone";
const TEST_SAVE_ROOT = path.join(here, ".local", "test-data");

const WEATHER_MARKER = '"WeatherControllerSerialized"';
const FORECAST_DAYS = 38;

function existingRoot(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** 按修改时间倒序列出 Saves 下的存档目录。 */
export function listSaves(saveRoot) {
  const savesDir = path.join(saveRoot, "Saves");
  let entries = [];
  try {
    entries = fs.readdirSync(savesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(savesDir, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        // 存档正在写入时会短暂不可读，忽略即可
      }
      return { name: entry.name, dir: full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function readEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0x10000 - 22);
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return {
        entries: buffer.readUInt16LE(i + 10),
        size: buffer.readUInt32LE(i + 12),
        offset: buffer.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error("zip: end of central directory not found");
}

/** 读取 zip 中单个条目（支持 stored / deflate）。 */
export function readZipEntry(zipPath, entryName) {
  const buffer = fs.readFileSync(zipPath);
  const eocd = readEndOfCentralDirectory(buffer);
  let cursor = eocd.offset;
  for (let i = 0; i < eocd.entries; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("zip: bad central directory record");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("zip: bad local file header");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      if (uncompressedSize && data.length !== uncompressedSize) {
        throw new Error("zip: stored entry size mismatch");
      }
      return data.toString("utf8");
    }
    if (method === 8) return zlib.inflateRawSync(data).toString("utf8");
    throw new Error(`zip: unsupported compression method ${method}`);
  }
  throw new Error(`zip: entry ${entryName} not found`);
}

/** 从 data.json 文本中截出并解析 WeatherControllerSerialized。 */
export function parseWeatherSection(dataJsonText) {
  const markerAt = dataJsonText.indexOf(WEATHER_MARKER);
  if (markerAt < 0) throw new Error("save: WeatherControllerSerialized not found");
  const start = dataJsonText.indexOf("{", markerAt);
  if (start < 0) throw new Error("save: weather section has no object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < dataJsonText.length; i++) {
    const ch = dataJsonText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(dataJsonText.slice(start, i + 1));
    }
  }
  throw new Error("save: unterminated weather section");
}

function readSaveInfo(saveDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(saveDir, "info.json"), "utf8"));
  } catch {
    return null;
  }
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** 汇总天气、月相和未来满月日。 */
export function summarizeWeather(weather, info = null) {
  const current = weather.CurrentWeather ?? {};
  const rawForecast = Array.isArray(weather.WeatherForecast) ? weather.WeatherForecast : [];
  const forecast = rawForecast.slice(0, FORECAST_DAYS).map((day, index) => ({
    day: index + 1,
    fullMoon: Boolean(day.IsFullMoon),
    clouds: round(day.Clouds),
    precipitation: round(day.Precipitation, 2),
    temperature: round(day.Temperature),
    windStrength: round(day.WindStrength),
    windDirection: round(day.WindDirection),
  }));
  const fullMoonDays = forecast.filter((day) => day.fullMoon).map((day) => day.day);
  const nextFullMoon = fullMoonDays.find((day) => day > 1) ?? null;
  return {
    ok: true,
    source: "save-data",
    save: info
      ? { name: info.Name ?? null, dateTime: info.DateTime ?? null, city: info.CityName ?? null }
      : null,
    current: {
      fullMoon: Boolean(current.IsFullMoon),
      clouds: round(current.Clouds),
      precipitation: round(current.Precipitation, 2),
      temperature: round(current.Temperature),
      windStrength: round(current.WindStrength),
      windDirection: round(current.WindDirection),
    },
    // 游戏内满月周期实测为 6 天一次
    nextFullMoonForecastDay: nextFullMoon,
    fullMoonForecastDays: fullMoonDays,
    forecastDays: forecast.length,
    forecast,
    caution:
      "数据取自最近一次自动存档，最多滞后约一个游戏日；满月夜通常伴随大规模尸潮。",
  };
}

function newestSaveSummary(saveRoot) {
  const saves = listSaves(saveRoot);
  if (!saves.length) throw new Error(`no save directory under ${path.join(saveRoot, "Saves")}`);
  for (const save of saves) {
    const zipPath = path.join(save.dir, "CompressedData.zip");
    if (!fs.existsSync(zipPath)) continue;
    try {
      const text = readZipEntry(zipPath, "data.json");
      const info = readSaveInfo(save.dir);
      const summary = summarizeWeather(parseWeatherSection(text), info);
      return { ...summary, saveRoot, saveName: save.name, saveUpdatedAt: new Date(save.mtime).toISOString() };
    } catch (error) {
      // 存档可能正在写入，继续尝试下一个
      if (save === saves[saves.length - 1]) throw error;
    }
  }
  throw new Error("no readable save with CompressedData.zip");
}

/**
 * 查询天气。saveRoot 省略时依次尝试 Steam 存档根目录和项目内测试存档。
 */
export function getWeather({ saveRoot = null } = {}) {
  const candidates = saveRoot ? [saveRoot] : [STEAM_SAVE_ROOT, TEST_SAVE_ROOT].filter(existingRoot);
  if (!candidates.length) {
    return {
      ok: false,
      code: "save_root_missing",
      message: "Neither the Steam save root nor .local/test-data exists. Pass save_root explicitly.",
    };
  }
  const errors = [];
  for (const root of candidates) {
    try {
      return newestSaveSummary(root);
    } catch (error) {
      errors.push(`${root}: ${error.message}`);
    }
  }
  return { ok: false, code: "weather_unreadable", message: errors.join(" | ") };
}

function formatText(result) {
  if (!result.ok) return `天气读取失败: ${result.message}`;
  const c = result.current;
  const lines = [];
  lines.push(`存档: ${result.saveName} (${result.save?.name ?? "?"})`);
  lines.push(`当前: ${c.fullMoon ? "🌕 满月" : "🌑 非满月"} | 云 ${c.clouds}% | 降水 ${c.precipitation} | 温度 ${c.temperature}°C | 风 ${c.windStrength}`);
  lines.push(`未来满月: 预报日 ${result.fullMoonForecastDays.join(", ") || "无"}`);
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const all = argv.includes("--all-forecast");
  const rootIndex = argv.indexOf("--save-root");
  const saveRoot = rootIndex >= 0 ? argv[rootIndex + 1] : null;
  const result = getWeather({ saveRoot });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatText(result)}\n`);
  if (all && result.ok) {
    for (const day of result.forecast) {
      process.stdout.write(
        `  第${String(day.day).padStart(2)}天: 温度 ${String(day.temperature).padStart(6)}°C · 云 ${String(day.clouds).padStart(3)}% · 降水 ${String(day.precipitation).padStart(4)} · 风 ${String(day.windStrength).padStart(4)}${day.fullMoon ? " · 🌕满月" : ""}\n`,
      );
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
