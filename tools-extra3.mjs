// 第三批工具：面向"敌人"的分析工具（只读为主）。
// 包含敌情总览、窝点清单、移动追踪、战力评估与敌群密度网格。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compass, readAll, summarizeThreats, summarizeSquads } from "./tools-extra.mjs";
import { listSaves, readZipEntry } from "./weather.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const moveCacheFile = path.join(here, ".local", "cache", "enemy-moves.json");

const HQ_FALLBACK = { x: 1430, z: 1146 };

// 粗略火力权重（仅用于战力对比启发式）
const WEAPON_POWER = {
  eq_assault_rifle: 1.0,
  eq_sniper_rifle: 1.1,
  eq_shotgun: 0.9,
  eq_pistol: 0.6,
  eq_crossbow: 0.7,
  eq_bow: 0.5,
  eq_flamethrower: 1.2,
  eq_basic_melee_weapon: 0.2,
  eq_inf_dog: 0.35,
  eq_inf_human: 0.4,
};

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function planar(ax, az, bx, bz) {
  return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
}

function isHostile(group) {
  return group.faction === "Infected" || group.faction === "Bandits";
}

function isLair(group) {
  return String(group.type ?? "").startsWith("hideout_");
}

function lairKind(type) {
  if (type.includes("inf_dog")) return "感染犬窝点";
  if (type.includes("inf_human")) return "感染者窝点";
  return "窝点";
}

// 感染者变体识别：优先看成员武器 ID，其次看群 type
const INFECTED_VARIANTS = {
  eq_inf_human: { label: "普通感染者", category: "人类", tier: 1, power: 0.4 },
  eq_inf_human_boosted: { label: "强化感染者", category: "人类", tier: 2, power: 0.55 },
  eq_inf_human_explosives: { label: "自爆感染者", category: "人类", tier: 3, power: 1.3 },
  eq_inf_alpha: { label: "阿尔法感染者", category: "人类", tier: 4, power: 1.6 },
  eq_inf_alpha_boosted: { label: "强化阿尔法感染者", category: "人类", tier: 5, power: 2.0 },
  eq_inf_dog: { label: "感染犬", category: "动物", tier: 1, power: 0.35 },
  eq_inf_dog_boosted: { label: "强化感染犬", category: "动物", tier: 2, power: 0.5 },
  eq_inf_bird: { label: "感染鸟", category: "鸟类", tier: 1, power: 0.5 },
  eq_inf_bird_boosted: { label: "强化感染鸟", category: "鸟类", tier: 2, power: 0.65 },
  eq_inf_growler: { label: "低吼者", category: "人类", tier: 2, power: 0.7 },
  eq_inf_growler_boosted: { label: "强化低吼者", category: "人类", tier: 3, power: 0.9 },
  eq_inf_screamer: { label: "尖啸者", category: "人类", tier: 2, power: 0.8 },
  eq_inf_screamer_boosted: { label: "强化尖啸者", category: "人类", tier: 3, power: 1.0 },
  eq_inf_huge: { label: "巨型感染者", category: "人类", tier: 3, power: 1.5 },
  eq_inf_huge_boosted: { label: "强化巨型感染者", category: "人类", tier: 4, power: 1.9 },
  eq_inf_tank_bull: { label: "巨兽-公牛", category: "动物", tier: 4, power: 2.0 },
  eq_inf_tank_moose: { label: "巨兽-驼鹿", category: "动物", tier: 4, power: 2.0 },
  eq_inf_tank_bull_boosted: { label: "强化巨兽-公牛", category: "动物", tier: 5, power: 2.4 },
  eq_inf_tank_moose_boosted: { label: "强化巨兽-驼鹿", category: "动物", tier: 5, power: 2.4 },
  eq_inf_bear: { label: "感染熊", category: "动物", tier: 3, power: 1.4 },
  eq_inf_bear_boosted: { label: "强化感染熊", category: "动物", tier: 4, power: 1.7 },
  eq_inf_moose: { label: "感染驼鹿", category: "动物", tier: 3, power: 1.4 },
  eq_inf_moose_boosted: { label: "强化感染驼鹿", category: "动物", tier: 4, power: 1.7 },
  eq_inf_bull: { label: "感染公牛", category: "动物", tier: 3, power: 1.4 },
};

const GROUP_TYPE_VARIANTS = {
  inf_human: "普通感染者",
  inf_dog: "感染犬",
  inf_alpha: "阿尔法感染者",
  inf_bird: "感染鸟",
  inf_tank_bear: "巨兽-熊",
  inf_tank_bull: "巨兽-公牛",
  inf_tank_moose: "巨兽-驼鹿",
};

const ANIMAL_SPECIES = {
  eq_animal_boar: "野猪",
  eq_animal_deer: "鹿",
  eq_inf_dog: "感染犬",
  eq_inf_dog_boosted: "强化感染犬",
  eq_inf_bird_boosted: "强化感染鸟",
  eq_inf_bear_boosted: "强化感染熊",
  eq_inf_moose_boosted: "强化感染驼鹿",
  eq_inf_tank_bear_boosted: "强化巨兽-熊",
  eq_inf_tank_bull_boosted: "强化巨兽-公牛",
  eq_inf_tank_moose_boosted: "强化巨兽-驼鹿",
  eq_inf_bird: "感染鸟",
  eq_inf_bear: "感染熊",
  eq_inf_moose: "感染驼鹿",
  eq_inf_bull: "感染公牛",
  eq_inf_tank_bear: "巨兽-熊",
  eq_inf_tank_bull: "巨兽-公牛",
  eq_inf_tank_moose: "巨兽-驼鹿",
};

/** 从成员武器 ID 推断动物物种。 */
export function animalSpeciesOf(group) {
  for (const member of group?.members ?? []) {
    const label = ANIMAL_SPECIES[member.weapon_id];
    if (label) return label;
  }
  const type = String(group?.type ?? "");
  if (type.includes("boar")) return "野猪";
  if (type.includes("deer")) return "鹿";
  if (type.includes("dog")) return "感染犬";
  if (type.includes("bird")) return "感染鸟";
  if (type.includes("bear")) return "感染熊";
  if (type.includes("moose")) return "感染驼鹿";
  if (type.includes("bull")) return "感染公牛";
  return null;
}

export function infectedVariantOf(member, group) {
  const byWeapon = INFECTED_VARIANTS[member?.weapon_id];
  if (byWeapon) return byWeapon;
  const byType = GROUP_TYPE_VARIANTS[String(group?.type ?? "").replace(/^hideout_infected_/, "")];
  if (byType) {
    const matched = Object.entries(INFECTED_VARIANTS).find(([, value]) => value.label === byType);
    if (matched) return matched[1];
  }
  const raw = String(group?.type ?? "");
  if (raw.includes("inf_dog")) return INFECTED_VARIANTS.eq_inf_dog;
  if (raw.includes("inf_human")) return INFECTED_VARIANTS.eq_inf_human;
  if (raw.includes("inf_alpha")) return INFECTED_VARIANTS.eq_inf_alpha;
  return { label: "未知感染体", tier: 0, power: 0.4 };
}

function weaponMix(group) {
  const mix = {};
  let firearms = 0;
  let melee = 0;
  let power = 0;
  for (const member of group.members ?? []) {
    const weapon = member.weapon_id ?? "eq_basic_melee_weapon";
    mix[weapon] = (mix[weapon] ?? 0) + 1;
    const variant = INFECTED_VARIANTS[weapon];
    const value = variant ? variant.power : WEAPON_POWER[weapon] ?? 0.3;
    power += value;
    if (weapon.includes("melee") || weapon.includes("inf_")) melee++;
    else firearms++;
  }
  return { mix, firearms, melee, power: round(power, 2) };
}

async function sessionState(request) {
  const state = await request("get_state", {});
  if (!state || state.ok !== true) {
    throw Object.assign(new Error(state?.message ?? "get_state failed"), { code: state?.code ?? "state_unavailable" });
  }
  return state;
}

function hqOf(state) {
  return state.headquarters ? { x: state.headquarters.x, z: state.headquarters.z } : HQ_FALLBACK;
}

function readMoveCache() {
  try {
    return JSON.parse(fs.readFileSync(moveCacheFile, "utf8"));
  } catch {
    return { groups: {}, at: null };
  }
}

function writeMoveCache(value) {
  try {
    fs.mkdirSync(path.dirname(moveCacheFile), { recursive: true });
    fs.writeFileSync(moveCacheFile, JSON.stringify(value), "utf8");
  } catch {
    // ignore
  }
}

async function loadGroups(request, sessionId) {
  return readAll(request, sessionId, "groups");
}

function hostileRows(groups, { hq, squads, radius, includeHidden }) {
  const rows = [];
  for (const group of groups) {
    if (!isHostile(group)) continue;
    if (!includeHidden && !group.visible) continue;
    const distance = round(planar(group.position.x, group.position.z, hq.x, hq.z));
    if (radius && distance > radius) continue;
    const destDistance = round(planar(group.destination?.x ?? group.position.x, group.destination?.z ?? group.position.z, hq.x, hq.z));
    const moving =
      Math.abs((group.destination?.x ?? 0) - (group.position?.x ?? 0)) > 20 ||
      Math.abs((group.destination?.z ?? 0) - (group.position?.z ?? 0)) > 20;
    const nearestSquad = squads
      .map((squad) => ({ squadId: squad.id, distance: round(planar(group.position.x, group.position.z, squad.position.x, squad.position.z)) }))
      .sort((a, b) => a.distance - b.distance)[0] ?? null;
    const weapons = weaponMix(group);
    const variants = {};
    let maxTier = 0;
    for (const member of group.members ?? []) {
      const variant = infectedVariantOf(member, group);
      variants[variant.label] = (variants[variant.label] ?? 0) + 1;
      if (variant.tier > maxTier) maxTier = variant.tier;
    }
    if (!Object.keys(variants).length && group.faction === "Infected") {
      const fallback = infectedVariantOf(null, group);
      variants[fallback.label] = group.member_count ?? 0;
      maxTier = fallback.tier;
    }
    rows.push({
      groupId: group.id,
      type: group.type,
      faction: group.faction,
      lair: isLair(group),
      members: group.member_count ?? (group.members ?? []).length,
      armedMembers: weapons.firearms,
      meleeMembers: weapons.melee,
      power: weapons.power,
      weaponMix: weapons.mix,
      variants,
      maxVariantTier: maxTier,
      position: { x: round(group.position.x), z: round(group.position.z) },
      destination: group.destination ? { x: round(group.destination.x), z: round(group.destination.z) } : null,
      distanceToHq: distance,
      direction: compass(group.position.x - hq.x, group.position.z - hq.z),
      moving,
      closing: destDistance < distance - 20,
      destinationDistanceToHq: destDistance,
      visible: Boolean(group.visible),
      hostileToPlayer: Boolean(group.hostile_to_player),
      nearestSquad,
    });
  }
  rows.sort((a, b) => a.distanceToHq - b.distanceToHq);
  return rows;
}

export function registerEnemyTools({ registerLocal, request, readOnly = false }) {
  registerLocal(
    "get_progression",
    "Read the save's ContentStateController: which buildings, productions, enemy spawn types and tech are unlocked vs still locked by story progression. Works offline (no game bridge needed).",
    {
      category: z.enum(["enemy", "building", "all"]).optional().describe("Filter view (default enemy)"),
      filter: z.string().min(1).max(60).optional().describe("Only ids containing this substring"),
      include_unlocked: z.boolean().optional().describe("Include already unlocked entries (default true)"),
    },
    async (args) => {
      const roots = [
        path.join(process.env.USERPROFILE ?? "", "AppData", "LocalLow", "JutsuGames", "Infection Free Zone"),
        "C:\\Users\\hp\\AppData\\LocalLow\\JutsuGames\\Infection Free Zone",
      ];
      let newest = null;
      for (const root of roots) {
        const saves = listSaves(root);
        if (saves.length) {
          newest = saves[0];
          break;
        }
      }
      if (!newest) return { ok: false, code: "no_save", message: "没有找到存档目录" };
      const text = readZipEntry(path.join(newest.dir, "CompressedData.zip"), "data.json").toString("utf8");
      const start = text.indexOf('"ContentStateController"');
      if (start < 0) return { ok: false, code: "no_content_state", message: "存档中没有 ContentStateController" };
      const segment = text.slice(start, start + 200000);
      const items = [...segment.matchAll(/\{\s*"id":\s*"([^"]+)",\s*"unlocked":\s*(true|false)\s*\}/g)].map((match) => ({
        id: match[1],
        unlocked: match[2] === "true",
      }));
      const category = args.category ?? "enemy";
      const enemyPattern = /inf_|bandit|provirus|immigrant|swarm|horde|Spawn_/i;
      const buildingPattern = /^bld_|^prod_|^tech_|^outtrans_|^pos_|^neg_/i;
      let rows = items;
      if (args.filter) rows = rows.filter((item) => item.id.toLowerCase().includes(String(args.filter).toLowerCase()));
      if (category === "enemy") rows = rows.filter((item) => enemyPattern.test(item.id));
      if (category === "building") rows = rows.filter((item) => buildingPattern.test(item.id));
      if (args.include_unlocked === false) rows = rows.filter((item) => !item.unlocked);
      return {
        ok: true,
        save: newest.name,
        total: items.length,
        unlockedCount: items.filter((item) => item.unlocked).length,
        lockedCount: items.filter((item) => !item.unlocked).length,
        category,
        rows,
      };
    },
  );

  registerLocal(
    "diagnose_pause",
    "Explain why the game is paused (popup / UI panel / manual or event pause / focus loss) and what can resume it.",
    {},
    async () => {
      const state = await sessionState(request);
      const time = state.time ?? {};
      const advice = [];
      let cause = "未暂停";
      if (time.popup_pause) {
        cause = "弹窗暂停（事件/决策弹窗）";
        advice.push("需要玩家在游戏内做出选择并关闭弹窗；桥接接口不能代替点击，AI 无法自行恢复。");
      } else if (time.ui_pause) {
        cause = "界面暂停（打开了面板/菜单）";
        advice.push("关闭当前面板（Esc）后游戏会恢复；若玩家在操作，等待其操作结束。");
      } else if (time.paused) {
        cause = "游戏暂停（玩家手动或事件触发）";
        advice.push("可按空格恢复；AI 端没有合法的 unpause 接口（插件禁用了强制恢复）。");
      }
      if (!state.focused) advice.push("游戏窗口未获得焦点：Unity 失焦会降频，恢复焦点后模拟才正常推进。");
      return {
        ok: true,
        time,
        cause,
        focused: state.focused,
        advance: state.advance ?? null,
        advice,
        hint: "调用 advance 前先确认 popup_pause/ui_pause 都为 false，否则会返回 paused_by_game。",
      };
    },
  );

  registerLocal(
    "wait_unpaused",
    "Poll until the game is unpaused (and no popup/UI pause), up to a timeout. Useful right before issuing orders.",
    { timeout_s: z.number().int().min(1).max(120).optional().describe("Max wait seconds (default 30)") },
    async (args) => {
      const timeout = (args.timeout_s ?? 30) * 1000;
      const started = Date.now();
      let state = await sessionState(request);
      while (Date.now() - started < timeout) {
        const time = state.time ?? {};
        if (!time.paused && !time.popup_pause && !time.ui_pause) {
          return { ok: true, waitedMs: Date.now() - started, paused: false, time };
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state = await sessionState(request);
      }
      const time = state.time ?? {};
      return {
        ok: false,
        code: time.popup_pause ? "paused_by_popup" : time.ui_pause ? "paused_by_ui" : "paused_by_game",
        waitedMs: Date.now() - started,
        time,
        message: "等待超时：需要玩家在游戏内处理暂停原因",
      };
    },
  );

  registerLocal(
    "get_enemy_report",
    "Enemy overview: every hostile group with type, member count, weapon mix, firepower score, distance/direction, whether it is moving toward the settlement, and the nearest squad.",
    {
      radius: z.number().min(100).max(5000).optional().describe("Max distance from HQ (default 2500)"),
      include_hidden: z.boolean().optional().describe("Include undiscovered groups (default true)"),
      min_size: z.number().int().min(1).max(500).optional().describe("Only groups with at least this many members"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups] = await Promise.all([readAll(request, sessionId, "squads"), loadGroups(request, sessionId)]);
      const hq = hqOf(state);
      const rows = hostileRows(groups, {
        hq,
        squads,
        radius: args.radius ?? 2500,
        includeHidden: args.include_hidden !== false,
      }).filter((row) => (args.min_size ? row.members >= args.min_size : true));
      const byFaction = {};
      for (const row of rows) byFaction[row.faction] = (byFaction[row.faction] ?? 0) + row.members;
      return {
        ok: true,
        time: state.time,
        hq,
        count: rows.length,
        totalMembers: rows.reduce((sum, row) => sum + row.members, 0),
        membersByFaction: byFaction,
        closing: rows.filter((row) => row.closing).map((row) => row.groupId),
        groups: rows,
      };
    },
  );

  registerLocal(
    "get_enemy_lairs",
    "List infected/bandit lairs (hideout groups) with strength, distance, direction and a rough threat ranking, so the AI can decide which nest to clear first.",
    {
      radius: z.number().min(100).max(6000).optional().describe("Max distance from HQ (default 4000)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups] = await Promise.all([readAll(request, sessionId, "squads"), loadGroups(request, sessionId)]);
      const hq = hqOf(state);
      const rows = hostileRows(groups, { hq, squads, radius: args.radius ?? 4000, includeHidden: true }).filter((row) => row.lair);
      return {
        ok: true,
        time: state.time,
        hq,
        count: rows.length,
        totalInfected: rows.filter((row) => row.faction === "Infected").reduce((sum, row) => sum + row.members, 0),
        lairs: rows.map((row) => ({ ...row, kind: lairKind(String(row.type)) })),
      };
    },
  );

  registerLocal(
    "get_enemy_moves",
    "Track hostile group movement between calls (persisted to .local/cache): shows groups that changed position/destination, their speed and estimated arrival at HQ.",
    {},
    async () => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups] = await Promise.all([readAll(request, sessionId, "squads"), loadGroups(request, sessionId)]);
      const hq = hqOf(state);
      const rows = hostileRows(groups, { hq, squads, radius: 5000, includeHidden: true });
      const previous = readMoveCache();
      const now = Date.now();
      const elapsedHours = previous.at ? Math.max(0.01, (now - previous.at) / 3600000) : 0;
      const moves = [];
      for (const row of rows) {
        const before = previous.groups?.[row.groupId];
        if (!before) continue;
        const moved = planar(before.x, before.z, row.position.x, row.position.z);
        if (moved < 5) continue;
        moves.push({
          groupId: row.groupId,
          faction: row.faction,
          members: row.members,
          from: before,
          now: row.position,
          movedDistance: round(moved),
          segmentHours: round(elapsedHours, 3),
          towardHq: row.closing,
          distanceToHq: row.distanceToHq,
        });
      }
      writeMoveCache({
        at: now,
        groups: Object.fromEntries(rows.map((row) => [row.groupId, row.position])),
      });
      return {
        ok: true,
        time: state.time,
        baseline: previous.at === null,
        trackedGroups: rows.length,
        moves,
        closingGroups: rows.filter((row) => row.closing).length,
      };
    },
  );

  registerLocal(
    "get_combat_estimate",
    "Compare firepower and check current attack conditions for selected player squads against a visible hostile group.",
    {
      squad_ids: z.array(z.string().min(1).max(64)).min(1).max(6).optional().describe("Squads to assess (default: all player squads)"),
      group_id: z.string().min(1).max(64),
      virtual: z.boolean().optional(),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups, weapons] = await Promise.all([
        readAll(request, sessionId, "squads"),
        readAll(request, sessionId, args.virtual ? "virtual_groups" : "groups"),
        readAll(request, sessionId, "weapons"),
      ]);
      const weaponTable = new Map(weapons.map((weapon) => [String(weapon.id), weapon]));
      const group = groups.find((entry) => String(entry.id) === args.group_id && entry.visible &&
        (entry.hostile_to_player ?? isHostile(entry)));
      if (!group) return { ok: false, code: "invalid_attack_target", message: "请选择当前可见的敌群。" };
      const squadRows = squads.filter((squad) => !args.squad_ids || args.squad_ids.includes(String(squad.id)));
      if (!squadRows.length || args.squad_ids?.some((id) => !squadRows.some((squad) => String(squad.id) === id)))
        return { ok: false, code: "squad_unavailable", message: "请选择当前存在的玩家小队。" };
      const checks = await Promise.all(squadRows.map(async (squad) => {
        try {
          const result = await request("get_attack_conditions", { session_id: sessionId,
            squad_id: String(squad.id), group_id: args.group_id, virtual: args.virtual });
          if (!result?.ok) return { squadId: squad.id, code: result?.code ?? "attack_conditions_unavailable" };
          return { squadId: squad.id, mode: result.mode, paused: result.paused, members: result.members };
        } catch {
          return { squadId: squad.id, code: "attack_conditions_unavailable" };
        }
      }));
      let squadPower = 0;
      let squadMembers = 0;
      let squadHp = 0;
      let squadHpMax = 0;
      let ammoTotal = 0;
      const squadDetail = [];
      for (const [index, squad] of squadRows.entries()) {
        let power = 0;
        let members = 0;
        for (const member of squad.members ?? []) {
          members++;
          power += WEAPON_POWER[member.weapon_id] ?? 0.3;
          ammoTotal += member.ammo ?? 0;
          squadHp += member.hp ?? 100;
          squadHpMax += member.max_hp ?? 100;
        }
        squadMembers += members;
        squadPower += power;
        const check = checks[index];
        const hp = squad.members?.map((member) => member.hp).filter(Number.isFinite) ?? [];
        squadDetail.push({ squadId: squad.id, members, power: round(power, 2), minHp: hp.length ? Math.min(...hp) : null,
          attack: check.mode === "settlement" ? {
            inRange: check.members.filter((member) => member.in_range).length,
            canEngage: check.members.filter((member) => member.can_engage_from_position).length,
            canAttackNow: check.members.filter((member) => member.can_attack_now).length,
          } : { mode: check.mode, code: check.code } });
      }
      const enemy = weaponMix(group);
      const ratio = enemy.power > 0 ? round(squadPower / enemy.power, 2) : null;
      let advice;
      const localChecks = checks.filter((check) => check.mode === "settlement");
      const liveMembers = localChecks.flatMap((check) => check.members);
      if (squadDetail.some((squad) => squad.minHp != null && squad.minHp < 60) ||
          liveMembers.some((member) => member.equipped_weapon_needs_ammo))
        advice = "所选小队有伤员或缺弹，先撤退或补给";
      else if (checks.some((check) => check.code)) advice = "开火条件读取失败，先核对目标与游戏连接";
      else if (localChecks.some((check) => check.paused)) advice = "游戏暂停中，恢复后重查开火条件";
      else if (localChecks.length && !liveMembers.some((member) => member.can_engage_from_position))
        advice = "当前站位无法交火，先检查距离、视线和载具状态";
      else if (localChecks.length && !liveMembers.some((member) => member.can_attack_now))
        advice = "当前还不能开火，检查队员冷却和状态";
      else if (ratio === null) advice = "敌群没有可评估武器，直接观察即可";
      else if (ratio >= 2.5) advice = "优势明显，可主动进攻（注意先集火再近身）";
      else if (ratio >= 1.6) advice = "有优势但不宽裕，建议诱敌/掩体/爆炸物先手";
      else if (ratio >= 1.0) advice = "势均力敌，不划算；建议增援或换目标";
      else advice = "明显劣势，避免交战";
      const enemyHp = (group.members ?? []).reduce((sum, member) => sum + (member.hp ?? 100), 0);
      return {
        ok: true,
        time: state.time,
        group: {
          id: group.id,
          type: group.type,
          faction: group.faction,
          members: group.member_count,
          weapons: enemy,
          totalHp: group.members ? round(enemyHp) : null,
          position: { x: round(group.position.x), z: round(group.position.z) },
        },
        squads: { count: squadRows.length, members: squadMembers, power: round(squadPower, 2), ammoTotal, hpRatio: squadHpMax ? round(squadHp / squadHpMax, 2) : null, detail: squadDetail },
        ratio,
        advice,
        weaponTable: {
          note: "弹匣容量来自 weapons 类目",
          sample: [...weaponTable.entries()].slice(0, 6).map(([id, weapon]) => ({ id, ammo: weapon.ammo_id, magazine: weapon.magazine_capacity })),
        },
      };
    },
  );

  registerLocal(
    "get_infected_types",
    "Break down infected groups by variant: normal infected, infected dogs, suicide bombers (explosives), alpha infected, birds, giants and boosted variants. Returns counts, HP range, tier and which squads are nearest.",
    {
      radius: z.number().min(100).max(6000).optional().describe("Max distance from HQ (default 4000)"),
      include_hidden: z.boolean().optional().describe("Include undiscovered groups (default true)"),
      include_lairs: z.boolean().optional().describe("Include lair groups (default true)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups] = await Promise.all([readAll(request, sessionId, "squads"), loadGroups(request, sessionId)]);
      const hq = hqOf(state);
      const includeHidden = args.include_hidden !== false;
      const includeLairs = args.include_lairs !== false;
      const byVariant = new Map();
      const groupRows = [];
      for (const group of groups) {
        if (group.faction !== "Infected") continue;
        if (!includeHidden && !group.visible) continue;
        if (!includeLairs && isLair(group)) continue;
        const distance = round(planar(group.position.x, group.position.z, hq.x, hq.z));
        if (args.radius && distance > args.radius) continue;
        const perGroup = new Map();
        let hpMin = Number.POSITIVE_INFINITY;
        let hpMax = 0;
        let maxTier = 0;
        for (const member of group.members ?? []) {
          const variant = infectedVariantOf(member, group);
          perGroup.set(variant.label, (perGroup.get(variant.label) ?? 0) + 1);
          hpMin = Math.min(hpMin, member.hp ?? 0);
          hpMax = Math.max(hpMax, member.max_hp ?? 0);
          if (variant.tier > maxTier) maxTier = variant.tier;
          if (!byVariant.has(variant.label)) byVariant.set(variant.label, { label: variant.label, category: variant.category ?? "人类", tier: variant.tier, power: variant.power, count: 0, groups: 0, hpMax: 0 });
          const bucket = byVariant.get(variant.label);
          bucket.count++;
          bucket.hpMax = Math.max(bucket.hpMax, member.max_hp ?? 0);
        }
        for (const label of perGroup.keys()) {
          const bucket = byVariant.get(label);
          if (bucket) bucket.groups++;
        }
        if (!group.members?.length && group.member_count) {
          const fallback = infectedVariantOf(null, group);
          if (!byVariant.has(fallback.label)) byVariant.set(fallback.label, { label: fallback.label, category: fallback.category ?? "人类", tier: fallback.tier, power: fallback.power, count: 0, groups: 0, hpMax: 0 });
          byVariant.get(fallback.label).count += group.member_count;
          byVariant.get(fallback.label).groups++;
        }
        const nearestSquad = squads
          .map((squad) => ({ squadId: squad.id, distance: round(planar(group.position.x, group.position.z, squad.position.x, squad.position.z)) }))
          .sort((a, b) => a.distance - b.distance)[0] ?? null;
        groupRows.push({
          groupId: group.id,
          type: group.type,
          lair: isLair(group),
          members: group.member_count,
          variants: Object.fromEntries(perGroup),
          maxVariantTier: maxTier,
          hp: { min: Number.isFinite(hpMin) ? round(hpMin) : null, max: hpMax ? round(hpMax) : null },
          distanceToHq: distance,
          direction: compass(group.position.x - hq.x, group.position.z - hq.z),
          visible: Boolean(group.visible),
          nearestSquad,
        });
      }
      groupRows.sort((a, b) => b.maxVariantTier - a.maxVariantTier || a.distanceToHq - b.distanceToHq);
      const variants = [...byVariant.values()].sort((a, b) => b.tier - a.tier || b.count - a.count);
      const byCategory = {};
      for (const variant of variants) byCategory[variant.category] = (byCategory[variant.category] ?? 0) + variant.count;
      return {
        ok: true,
        time: state.time,
        hq,
        groupCount: groupRows.length,
        totalInfected: groupRows.reduce((sum, row) => sum + (row.members ?? 0), 0),
        variants,
        byCategory,
        groups: groupRows,
      };
    },
  );

  registerLocal(
    "get_animal_report",
    "Animals overview: infected animals (dogs, birds, bears, moose, bulls, giants) plus normal wildlife (boar, deer), with species, count, distance and hostility.",
    {
      radius: z.number().min(100).max(6000).optional().describe("Max distance from HQ (default 4000)"),
      include_normal: z.boolean().optional().describe("Include non-infected wildlife (default true)"),
      include_hidden: z.boolean().optional().describe("Include undiscovered groups (default true)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups] = await Promise.all([readAll(request, sessionId, "squads"), loadGroups(request, sessionId)]);
      const hq = hqOf(state);
      const includeHidden = args.include_hidden !== false;
      const includeNormal = args.include_normal !== false;
      const speciesCounts = new Map();
      const rows = [];
      for (const group of groups) {
        const infected = group.faction === "Infected";
        const wildlife = group.faction === "Animals";
        if (!infected && !(wildlife && includeNormal)) continue;
        if (!includeHidden && !group.visible) continue;
        const species = animalSpeciesOf(group) ?? (infected ? "未知感染体" : "未知动物");
        const isAnimal =
          wildlife ||
          Object.keys(INFECTED_VARIANTS).some((key) => key in (group.members ?? []).reduce((acc, m) => (m.weapon_id ? { ...acc, [m.weapon_id]: true } : acc), {})) ||
          String(group.type ?? "").includes("inf_dog") ||
          String(group.type ?? "").includes("inf_bird") ||
          String(group.type ?? "").includes("tank_");
        if (!isAnimal) continue;
        const distance = round(planar(group.position.x, group.position.z, hq.x, hq.z));
        if (args.radius && distance > args.radius) continue;
        speciesCounts.set(species, (speciesCounts.get(species) ?? 0) + (group.member_count ?? 0));
        rows.push({
          groupId: group.id,
          type: group.type,
          faction: group.faction,
          species,
          infected,
          hostile: infected,
          members: group.member_count,
          position: { x: round(group.position.x), z: round(group.position.z) },
          distanceToHq: distance,
          direction: compass(group.position.x - hq.x, group.position.z - hq.z),
          visible: Boolean(group.visible),
        });
      }
      rows.sort((a, b) => b.infected - a.infected || a.distanceToHq - b.distanceToHq);
      return {
        ok: true,
        time: state.time,
        hq,
        count: rows.length,
        infectedAnimals: rows.filter((row) => row.infected).length,
        normalAnimals: rows.filter((row) => !row.infected).length,
        speciesCounts: [...speciesCounts.entries()].sort((a, b) => b[1] - a[1]).map(([species, count]) => ({ species, count })),
        groups: rows,
      };
    },
  );

  registerLocal(
    "get_neutral_report",
    "List non-hostile groups: neutral bandits (hostile_to_player=false), animals, immigrants and other neutral factions, with weapons, distance and whether they can be attacked at all.",
    {
      radius: z.number().min(100).max(6000).optional().describe("Max distance from HQ (default 3000)"),
      include_animals: z.boolean().optional().describe("Include animal groups (default true)"),
      include_hidden: z.boolean().optional().describe("Include undiscovered groups (default true)"),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups] = await Promise.all([readAll(request, sessionId, "squads"), loadGroups(request, sessionId)]);
      const hq = hqOf(state);
      const includeAnimals = args.include_animals !== false;
      const includeHidden = args.include_hidden !== false;
      const rows = [];
      for (const group of groups) {
        if (isHostile(group)) continue;
        if (!includeAnimals && group.faction === "Animals") continue;
        if (!includeHidden && !group.visible) continue;
        const distance = round(planar(group.position.x, group.position.z, hq.x, hq.z));
        if (args.radius && distance > args.radius) continue;
        const weapons = weaponMix(group);
        rows.push({
          groupId: group.id,
          type: group.type,
          faction: group.faction,
          species: animalSpeciesOf(group),
          hostileToPlayer: Boolean(group.hostile_to_player),
          attackable: false,
          members: group.member_count ?? (group.members ?? []).length,
          weaponMix: weapons.mix,
      variants,
      maxVariantTier: maxTier,
          position: { x: round(group.position.x), z: round(group.position.z) },
          distanceToHq: distance,
          direction: compass(group.position.x - hq.x, group.position.z - hq.z),
          visible: Boolean(group.visible),
          note: group.faction === "Animals" ? "野生动物，不可攻击；可驱赶/无视" : "非敌对，不可直接攻击（攻击接口要求 IsEnemy）",
        });
      }
      rows.sort((a, b) => a.distanceToHq - b.distanceToHq);
      const byFaction = {};
      for (const row of rows) byFaction[row.faction] = (byFaction[row.faction] ?? 0) + row.members;
      return {
        ok: true,
        time: state.time,
        hq,
        count: rows.length,
        totalMembers: rows.reduce((sum, row) => sum + row.members, 0),
        membersByFaction: byFaction,
        groups: rows,
      };
    },
  );

  registerLocal(
    "get_enemy_density",
    "ASCII heatmap of hostile group members over the map (default 250-unit cells), useful for seeing where the threats concentrate.",
    {
      step: z.number().min(100).max(600).optional().describe("Cell size (default 250)"),
      radius: z.number().min(200).max(6000).optional().describe("Radius from HQ (default 3000)"),
      include_hidden: z.boolean().optional(),
    },
    async (args) => {
      const state = await sessionState(request);
      const sessionId = state.session_id;
      const [squads, groups, map] = await Promise.all([
        readAll(request, sessionId, "squads"),
        loadGroups(request, sessionId),
        readAll(request, sessionId, "map"),
      ]);
      const hq = hqOf(state);
      const rows = hostileRows(groups, { hq, squads, radius: args.radius ?? 3000, includeHidden: args.include_hidden !== false });
      const step = args.step ?? 250;
      const bounds = map[0]?.bounds ?? { min_x: 54, min_z: 54, max_x: 2121, max_z: 2121 };
      const cols = Math.floor((bounds.max_x - bounds.min_x) / step) + 1;
      const rowCount = Math.floor((bounds.max_z - bounds.min_z) / step) + 1;
      const sums = Array.from({ length: rowCount }, () => new Array(cols).fill(0));
      for (const row of rows) {
        const col = Math.min(cols - 1, Math.max(0, Math.round((row.position.x - bounds.min_x) / step)));
        const index = Math.min(rowCount - 1, Math.max(0, Math.round((row.position.z - bounds.min_z) / step)));
        sums[index][col] += row.members;
      }
      const hqCol = Math.round((hq.x - bounds.min_x) / step);
      const hqRow = Math.round((hq.z - bounds.min_z) / step);
      const ascii = sums.map((line, index) =>
        line
          .map((value, col) => {
            if (index === hqRow && col === hqCol) return "@";
            if (value === 0) return ".";
            if (value < 10) return "1";
            if (value < 30) return "2";
            if (value < 60) return "3";
            if (value < 100) return "4";
            return "5";
          })
          .join(""),
      );
      return {
        ok: true,
        step,
        cols,
        rowCount,
        bounds,
        legend: ". 无敌人 1 <10 2 <30 3 <60 4 <100 5 ≥100 名成员 @ 总部",
        groups: rows.length,
        totalMembers: rows.reduce((sum, row) => sum + row.members, 0),
        ascii,
      };
    },
  );
}
