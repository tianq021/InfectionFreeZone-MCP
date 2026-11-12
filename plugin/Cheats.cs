using System;
using System.Collections.Generic;
using System.Linq;
using Commands;
using Controllers;
using Controllers.Time;
using Data.Resorces;
using Gameplay.GameResources;
using Gameplay.Units;
using Gameplay.Units.Enemy;
using Gameplay.Vehicles;
using JutsuGamesConfig.Runtime;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Utilities;

namespace IfzMcp;

/// <summary>
/// 作弊/调试工具：封装游戏自带的 GameConsoleCommandHandler 与少量直接容器操作。
/// 只在持有写租约（lease）时可调用，用于加速剧情验证与紧急救援。
/// </summary>
public sealed partial class Plugin
{
    private static GameConsoleCommandHandler CheatConsole()
    {
        var handler = GameConsoleCommandHandler.Instance;
        if (handler == null)
            throw new BridgeException("not_ready", "The game console handler is not initialized yet (load a settlement first).");
        return handler;
    }

    private object ExecuteCheat(string method, JObject args)
    {
        switch (method)
        {
            case "cheat_list":
                return CheatList();
            case "cheat_heal_squads":
                return CheatHealSquads(args);
            case "cheat_refill_ammo":
                return CheatRefillAmmo();
            case "cheat_add_resources":
                return CheatAddResources(args);
            case "cheat_unlock_expedition":
                return CheatUnlockExpedition();
            case "cheat_complete_missions":
                return CheatCompleteMissions();
            case "cheat_complete_mission":
                return CheatCompleteMission(args);
            case "cheat_scavenge_all":
                return CheatScavengeAll();
            case "cheat_set_time":
                return CheatSetTime(args);
            case "cheat_spawn_squad":
                return CheatSpawnSquad(args);
            case "cheat_reveal_groups":
                return CheatRevealGroups();
            default:
                throw new BridgeException("unknown_method", "Unknown cheat method.");
        }
    }

    private object ApplyGroupedCheat(JObject args)
    {
        var action = Text(args, "action", 80);
        var parameters = args["params"] as JObject ??
            throw new BridgeException("invalid_cheat_params", "Provide a parameters object.");
        return action switch
        {
            "spawn_infected" => CheatSpawnInfected(parameters),
            "give_weapon" => CheatGiveWeapon(parameters),
            "add_resources" or "refill_ammo" or "heal_squads" or "spawn_squad" or "reveal_groups" or
                "unlock_expedition" or "scavenge_all" or "set_time" or "complete_mission" or "complete_missions" =>
                ExecuteCheat("cheat_" + action, parameters),
            _ => throw new BridgeException("unknown_cheat", "Choose an action from cheat_catalog.")
        };
    }

    private object CheatSpawnInfected(JObject args)
    {
        var count = (int?)args["count"] ?? 1;
        if (count is < 1 or > 12)
            throw new BridgeException("invalid_count", "count must be between 1 and 12.");
        var ground = FindGround(new Vector3(Coordinate(args, "x"), 25f, Coordinate(args, "z")));
        var draft = Configs.GetConfig<GroupsConfig>().GetDraftByName("inf_human");
        var group = WorldContainer().Resolve<GroupBuilder>().SpawnGroupAt(ground, draft, count);
        if (group == null)
            throw new BridgeException("spawn_rejected", "The game refused to create an infected group there.");
        group.Show();
        return new { group_id = group.Id.ToString(), type = "inf_human",
            members = group.Characters.Count(), position = Position(group.Position), visible = group.IsVisible() };
    }

    private object CheatGiveWeapon(JObject args)
    {
        var weapon = Text(args, "weapon_id", 80);
        if (!Enum.TryParse<ResourceID>(weapon, out var id) || id.ToString() != weapon ||
            !ResourcesDataContainer.Instance.IsWeapon(id))
            throw new BridgeException("invalid_weapon", "Use a weapon_id from get_weapon_details.");
        var quantity = (int?)args["quantity"] ?? 0;
        if (quantity is < 1 or > 1000)
            throw new BridgeException("invalid_amount", "Use a whole weapon quantity between 1 and 1000.");
        return CheatAddResources(new JObject { ["resource_id"] = weapon, ["quantity"] = quantity });
    }

    private static object CheatList() => new
    {
        cheats = new object[]
        {
            new { name = "cheat_heal_squads", args = "hp (optional)", note = "把玩家小队所有成员治疗到满血（保留最大血量）" },
            new { name = "cheat_refill_ammo", args = "none", note = "玩家小队所有武器弹药补满" },
            new { name = "cheat_add_resources", args = "resource_id, quantity", note = "直接向共享库存添加资源（绕过采集）" },
            new { name = "cheat_unlock_expedition", args = "none", note = "解锁全部远征地块" },
            new { name = "cheat_complete_missions", args = "none", note = "立即完成所有进行中的任务/事件目标" },
            new { name = "cheat_scavenge_all", args = "none", note = "把所有废弃建筑一次性标记为已搜刮" },
            new { name = "cheat_set_time", args = "day?, hour?, speed?", note = "设置天数/小时/时间流速" },
            new { name = "cheat_spawn_squad", args = "x, z, count?, vehicle?", note = "在指定坐标生成一支玩家小队" },
            new { name = "cheat_reveal_groups", args = "none", note = "显示所有敌对群（含隐藏）" }
        }
    };

    private object CheatHealSquads(JObject args)
    {
        var controller = WorldContainer().Resolve<SquadsController>();
        var healed = 0;
        var beforeMin = float.MaxValue;
        var lowHp = new List<object>();
        foreach (var squad in controller.Squads)
        {
            if (squad == null || squad.IsDestroying) continue;
            foreach (var character in squad.Characters)
            {
                var health = character?.Health;
                if (health == null) continue;
                var hp = health.Hp;
                if (hp < beforeMin) beforeMin = hp;
                if (hp < health.MaxHp - 0.5f)
                    lowHp.Add(new { squad_id = squad.Id.ToString(), character_id = character.Id.ToString(), hp, max_hp = health.MaxHp });
                health.SetMaxHealth();
                healed++;
            }
        }
        return new { healed, min_hp_before = healed == 0 ? 0f : beforeMin, wounded = lowHp };
    }

    private object CheatRefillAmmo()
    {
        var controller = WorldContainer().Resolve<SquadsController>();
        var refilled = 0;
        foreach (var squad in controller.Squads)
        {
            if (squad == null || squad.IsDestroying) continue;
            foreach (var character in squad.Characters)
            {
                var handler = character?.ItemsContainer?.AmmunitionHandler;
                if (handler == null) continue;
                handler.SetMaxAmmo();
                refilled++;
            }
        }
        return new { refilled };
    }

    private object CheatAddResources(JObject args)
    {
        var name = Text(args, "resource_id", 64);
        if (!Enum.TryParse<ResourceID>(name, out var resourceId) || resourceId == ResourceID.None)
            throw new BridgeException("invalid_resource", "Unknown resource_id; pass an exact ResourceID name such as res_metal.");
        var quantity = (float?)args["quantity"] ?? 100f;
        if (!float.IsFinite(quantity) || quantity <= 0f || quantity > 1000000f)
            throw new BridgeException("invalid_amount", "Use a quantity between 0 and 1000000.");
        var container = WorldContainer().Resolve<StockroomsController>().Container;
        var before = container.GetResourceQuantity(resourceId);
        var applied = container.AddResource(resourceId, quantity, ResourceAddReason.None);
        if (!applied)
            throw new BridgeException("stock_rejected", "The stockpile rejected the resource (capacity or unavailable).");
        var after = container.GetResourceQuantity(resourceId);
        return new { resource_id = resourceId.ToString(), before, added = after - before, amount = after };
    }

    private object CheatUnlockExpedition()
    {
        CheatConsole().UnlockAllExpeditionTiles();
        return new { applied = true, note = "All expedition tiles unlocked." };
    }

    private object CheatCompleteMissions()
    {
        CheatConsole().CompleteActiveMissions();
        return new { applied = true, note = "Active missions completed." };
    }

    private object CheatScavengeAll()
    {
        CheatConsole().ScavengeAllBuildings();
        return new { applied = true, note = "Abandoned buildings marked as scavenged." };
    }

    private object CheatSetTime(JObject args)
    {
        var handler = CheatConsole();
        var changed = new List<string>();
        if (args["day"] != null)
        {
            var day = (int)args["day"];
            if (day is < 1 or > 10000)
                throw new BridgeException("invalid_day", "Day must be between 1 and 10000.");
            handler.SetDay(day);
            changed.Add("day");
        }
        if (args["hour"] != null)
        {
            var hour = (int)args["hour"];
            if (hour is < 0 or > 23)
                throw new BridgeException("invalid_hour", "Hour must be between 0 and 23.");
            handler.SetHour(hour);
            changed.Add("hour");
        }
        if (args["speed"] != null)
        {
            var speedValue = (float)args["speed"];
            if (!float.IsFinite(speedValue) || speedValue is < 0f or > 100f)
                throw new BridgeException("invalid_speed", "Speed must be between 0 and 100.");
            handler.SetTimeSpeed(speedValue);
            changed.Add("speed");
        }
        if (changed.Count == 0)
            throw new BridgeException("invalid_argument", "Provide day, hour or speed.");
        return new { changed, day = TimeController.Day, hour = TimeController.Hour };
    }

    private object CheatSpawnSquad(JObject args)
    {
        var handler = CheatConsole();
        var x = Coordinate(args, "x");
        var z = Coordinate(args, "z");
        var count = (int?)args["count"] ?? 4;
        if (count is < 1 or > 12)
            throw new BridgeException("invalid_count", "count must be between 1 and 12.");
        var vehicleName = (string)args["vehicle"] ?? "ve_sedan";
        if (!Enum.TryParse<VehicleType>(vehicleName, out var vehicleType))
            throw new BridgeException("invalid_vehicle", "Unknown vehicle type; use an exact VehicleType name such as ve_pickup.");
        var ground = FindGround(new Vector3(x, 25f, z));
        var squad = handler.SpawnSquadAt(ground, count, vehicleType);
        if (squad == null)
            throw new BridgeException("spawn_rejected", "The game refused to create a squad at that position.");
        return new
        {
            squad_id = squad.Id.ToString(),
            members = squad.Characters.Count(),
            position = Position(squad.Position)
        };
    }

    private object CheatRevealGroups()
    {
        var container = WorldContainer();
        var shown = 0;
        foreach (var group in container.Resolve<GroupsController>().Groups)
        {
            if (group == null) continue;
            group.Show();
            shown++;
        }
        foreach (var group in container.Resolve<VirtualGroupsController>().Groups)
        {
            if (group == null) continue;
            group.Show();
            shown++;
        }
        return new { shown };
    }
}
