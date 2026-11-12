using System;
using System.Collections.Generic;
using System.Linq;
using Controllers;
using Data.Resorces;
using Gameplay.Buildings;
using Gameplay.GameResources;
using Gameplay.ObjectOnMap.POI;
using MapOperator.Runtime.Data;
using MapOperator.Runtime.Utils.Extensions;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

/// <summary>
/// 建筑详情、资源图标(POI)与搜刮进度。
/// 地图上建筑显示的"枪/油/药品/工具"等图标由 OSM 标签与 PoiArchetype 匹配决定，
/// 这里复用游戏的 GameplayPoiContainer.GetTagsForPoiArchetype 做同样的判定。
/// ScavengeWork.ResourcesToFind 在玩家小队首次进入废墟时才生成，
/// 未进入过的建筑只能返回"未生成"，进入后即可读到剩余物资与进度。
/// </summary>
public sealed partial class Plugin
{
    private static readonly PoiArchetype[] PoiIconArchetypes =
    {
        PoiArchetype.Research, PoiArchetype.Drugs, PoiArchetype.Tools, PoiArchetype.Food,
        PoiArchetype.Bakery, PoiArchetype.Barn, PoiArchetype.Fuel, PoiArchetype.Gun,
        PoiArchetype.Parking, PoiArchetype.Expedition, PoiArchetype.Warehouse,
        PoiArchetype.Sport, PoiArchetype.Museum, PoiArchetype.Metal
    };

    private static readonly Dictionary<PoiArchetype, List<OsmTag>> PoiTagCache = new();

    private static List<OsmTag> PoiTags(PoiArchetype archetype)
    {
        if (PoiTagCache.TryGetValue(archetype, out var cached) && cached != null) return cached;
        var tags = worldMap?.PoiContainer?.GetTagsForPoiArchetype(archetype) ?? new List<OsmTag>();
        PoiTagCache[archetype] = tags;
        return tags;
    }

    private static List<string> PoiFlagsOf(Building building)
    {
        var flags = new List<string>();
        var osmTags = building?.OsmBuilding?.Tags;
        if (osmTags == null) return flags;
        foreach (var archetype in PoiIconArchetypes)
        {
            foreach (var tag in PoiTags(archetype))
            {
                if (!osmTags.ContainsOsmTag(tag)) continue;
                var name = archetype.ToString();
                if (!flags.Contains(name)) flags.Add(name);
                break;
            }
        }
        return flags;
    }

    private static List<object> LootRows(IEnumerable<KeyValuePair<ResourceID, float>> resources)
    {
        var rows = new List<object>();
        if (resources == null) return rows;
        foreach (var pair in resources)
        {
            if (pair.Value <= 0f) continue;
            rows.Add(new { resource_id = pair.Key.ToString(), quantity = pair.Value });
        }
        return rows;
    }

    private static object ScavengeSnapshot(Building building)
    {
        var work = building.ScavengeWork;
        if (work == null)
            return new { initialized = false, note = "尚未生成搜刮物资：需要玩家小队首次进入该废墟后才会生成" };
        var remaining = new List<object>();
        var remainingQuantity = 0f;
        foreach (var crate in work.ResourcesToFind ?? new List<ResourceCrate>())
        {
            if (crate == null || crate.Quantity <= 0f) continue;
            remaining.Add(new { resource_id = crate.ResourceID.ToString(), quantity = crate.Quantity });
            remainingQuantity += crate.Quantity;
        }
        var totalTime = work.TimeToScavenge;
        var leftTime = work.TimeLeftToScavenge;
        var progress = totalTime > 0f ? Mathf.Clamp01(1f - leftTime / totalTime) : 0f;
        return new
        {
            initialized = true,
            done = work.IsDone,
            progress01 = Mathf.Round(progress * 1000f) / 1000f,
            time_to_scavenge = totalTime,
            time_left = leftTime,
            remaining_crates = remaining,
            remaining_quantity = remainingQuantity,
            found_in_building = LootRows(building.ResourcesContainer?.Resources)
        };
    }

    private object ReadBuildingInfo(JObject args)
    {
        var building = FindBuilding(Text(args, "building_id", 64));
        var center = building.CenterPosition;
        var aabb = building.AABB;
        var flags = PoiFlagsOf(building);
        return new
        {
            id = building.Id,
            osm_id = building.OsmId,
            type = building.Type,
            state = building.StateMachine?.CurrentState?.StateType.ToString(),
            completed = building.IsCompleted,
            can_scavenge = building.CanScavenge(),
            scavenged = building.IsScavenged(),
            stockroom = building.IsStockroom(),
            had_resources_to_find = building.HadResourcesToFind,
            poi_icons = flags,
            has_gun = flags.Contains(nameof(PoiArchetype.Gun)),
            has_fuel = flags.Contains(nameof(PoiArchetype.Fuel)),
            has_drugs = flags.Contains(nameof(PoiArchetype.Drugs)),
            has_tools = flags.Contains(nameof(PoiArchetype.Tools)),
            has_metal = flags.Contains(nameof(PoiArchetype.Metal)),
            has_warehouse = flags.Contains(nameof(PoiArchetype.Warehouse)),
            position = Position(center),
            bounds = new { min_x = aabb.xMin, min_z = aabb.yMin, max_x = aabb.xMax, max_z = aabb.yMax },
            scavenge = ScavengeSnapshot(building)
        };
    }

    private object ReadScavengeProgress(JObject args)
    {
        var limit = (int?)args["limit"] ?? 50;
        if (limit is < 1 or > 200)
            throw new BridgeException("invalid_limit", "limit must be between 1 and 200.");
        var buildings = WorldContainer().Resolve<BuildingsController>().Buildings;
        var rows = new List<object>();
        foreach (var building in buildings)
        {
            if (building == null || building.ScavengeWork == null) continue;
            var work = building.ScavengeWork;
            if (work.IsDone) continue;
            var totalTime = work.TimeToScavenge;
            var leftTime = work.TimeLeftToScavenge;
            var progress = totalTime > 0f ? Mathf.Clamp01(1f - leftTime / totalTime) : 0f;
            var remaining = (work.ResourcesToFind ?? new List<ResourceCrate>())
                .Where(crate => crate != null && crate.Quantity > 0f)
                .Select(crate => new { resource_id = crate.ResourceID.ToString(), quantity = crate.Quantity })
                .ToList();
            rows.Add(new
            {
                building_id = building.Id,
                osm_id = building.OsmId,
                type = building.Type,
                position = Position(building.CenterPosition),
                progress01 = Mathf.Round(progress * 1000f) / 1000f,
                time_left = leftTime,
                remaining_count = remaining.Count,
                remaining,
                characters_inside = building.CharactersInside?.Count ?? 0
            });
            if (rows.Count >= limit) break;
        }
        return new { count = rows.Count, in_progress = rows };
    }

    private object FindBuildingsByPoi(JObject args)
    {
        var names = new List<string>();
        if (args["poi"] is JArray array)
        {
            foreach (var token in array)
            {
                var value = (string)token;
                if (!string.IsNullOrWhiteSpace(value)) names.Add(value);
            }
        }
        if (names.Count == 0)
            throw new BridgeException("invalid_poi", "Pass poi: an array such as [\"Gun\",\"Fuel\"].");
        var wanted = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
        var radius = (float?)args["radius"] ?? 2500f;
        var limit = (int?)args["limit"] ?? 60;
        if (limit is < 1 or > 300)
            throw new BridgeException("invalid_limit", "limit must be between 1 and 300.");
        var onlyScavengeable = (bool?)args["only_scavengeable"] ?? true;
        Vector3? origin = null;
        if (args["x"] != null && args["z"] != null)
            origin = new Vector3(Coordinate(args, "x"), 25f, Coordinate(args, "z"));
        else if (HqController.MainHeadquarter != null)
            origin = HqController.MainHeadquarter.Position;
        var rows = new List<(object row, float distance)>();
        foreach (var building in WorldContainer().Resolve<BuildingsController>().Buildings)
        {
            if (building == null) continue;
            if (onlyScavengeable && (!building.CanScavenge() || building.IsScavenged() || building.IsStockroom())) continue;
            var flags = PoiFlagsOf(building);
            var matched = flags.Where(flag => wanted.Contains(flag)).ToList();
            if (matched.Count == 0) continue;
            var center = building.CenterPosition;
            var distance = origin.HasValue ? PlanarDistance(origin.Value, center) : 0f;
            if (origin.HasValue && distance > radius) continue;
            rows.Add((new
            {
                building_id = building.Id,
                osm_id = building.OsmId,
                type = building.Type,
                matched,
                poi_icons = flags,
                position = Position(center),
                distance = Mathf.Round(distance),
                can_scavenge = building.CanScavenge(),
                scavenged = building.IsScavenged()
            }, distance));
            if (rows.Count >= limit) break;
        }
        return new
        {
            count = rows.Count,
            poi = names,
            results = rows.OrderBy(entry => entry.distance).Select(entry => entry.row).ToList()
        };
    }
}