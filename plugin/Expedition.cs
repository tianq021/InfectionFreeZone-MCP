using System;
using System.Collections.Generic;
using System.Linq;
using Controllers;
using Expedition;
using Gameplay.GameResources;
using Gameplay.ObjectOnMap.POI;
using Gameplay.Vehicles;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

/// <summary>
/// 远征地块与全图车辆。
/// - 远征：读取 ExpeditionGridController.AllExpeditionTiles（已加载的远征瓦片），
///   含地块类型/位置类型/POI 资源图标统计/可搜刮状态/搜刮进度/已获得资源。
///   需要先在游戏里打开世界地图（远征界面）让瓦片加载，否则返回 expedition_not_ready。
/// - 车辆：读取 VehiclesController.Vehicles 全量（默认包含未发现的废弃车辆），
///   而 get_world_data(vehicles) 只返回已发现或玩家拥有的车辆。
/// </summary>
public sealed partial class Plugin
{
    private static object ReadExpeditionTiles(JObject args)
    {
        var grid = UnityEngine.Object.FindObjectOfType<ExpeditionGridController>();
        if (grid == null || grid.AllExpeditionTiles == null || grid.AllExpeditionTiles.Count == 0)
            throw new BridgeException("expedition_not_ready", "远征瓦片还没加载：先在游戏里打开世界地图（远征）界面再查询。");
        var interactions = UnityEngine.Object.FindObjectOfType<ExpeditionTilesInteraction>();
        var origin = HqController.MainHeadquarter != null ? HqController.MainHeadquarter.Position : Vector3.zero;
        var radius = (float?)args["radius"] ?? 0f;
        var onlyScavengable = (bool?)args["only_scavengable"] ?? false;
        var limit = (int?)args["limit"] ?? 100;
        if (limit is < 1 or > 400)
            throw new BridgeException("invalid_limit", "limit must be between 1 and 400.");
        var rows = new List<(object row, float distance)>();
        foreach (var pair in grid.AllExpeditionTiles)
        {
            var coordinate = pair.Key;
            var tile = pair.Value;
            if (tile == null) continue;
            if (onlyScavengable && !tile.Scavengable) continue;
            var distance = PlanarDistance(origin, tile.Position);
            if (radius > 0f && distance > radius) continue;

            var enabled = false;
            var inFog = true;
            if (interactions != null && interactions.Tiles != null &&
                interactions.Tiles.TryGetValue(coordinate, out var iconTile) && iconTile != null)
            {
                enabled = iconTile.IsInteractionEnable;
                inFog = iconTile.IsInFog;
            }

            var poi = new Dictionary<string, int>();
            if (tile.PoiTypeOccurences != null)
                foreach (var entry in tile.PoiTypeOccurences)
                    poi[entry.Key.ToString()] = entry.Value;

            var resources = new Dictionary<string, float>();
            if (tile.ResourcesContainer?.Resources != null)
                foreach (var entry in tile.ResourcesContainer.Resources)
                    if (entry.Value > 0f) resources[entry.Key.ToString()] = entry.Value;

            float progress = 0f;
            float timeLeft = 0f;
            var remainingCrates = 0;
            var work = tile.ScavengeWork;
            if (work != null)
            {
                timeLeft = work.TimeLeftToScavenge;
                progress = work.TimeToScavenge > 0f ? Mathf.Clamp01(1f - timeLeft / work.TimeToScavenge) : 0f;
                remainingCrates = (work.ResourcesToFind ?? new List<ResourceCrate>())
                    .Count(crate => crate != null && crate.Quantity > 0f);
            }

            rows.Add((new
            {
                tx = coordinate.Tx,
                ty = coordinate.Ty,
                zoom = coordinate.Zoom,
                position = Position(tile.Position),
                distance = Mathf.Round(distance),
                enabled,
                in_fog = inFog,
                area_type = tile.areaType.ToString(),
                location_type = tile.LocationType.ToString(),
                scavengable = tile.Scavengable,
                walkable = tile.Walkable,
                scavenge_initialized = tile.IsScavengingInitialized,
                poi_icons = poi,
                scavenge = new { progress01 = progress, time_left = timeLeft, remaining_crates = remainingCrates },
                resources
            }, distance));
        }
        var tiles = rows.OrderBy(entry => entry.distance).Take(limit).Select(entry => entry.row).ToList();
        return new
        {
            count = tiles.Count,
            matched_total = rows.Count,
            truncated = rows.Count > limit,
            total_loaded = grid.AllExpeditionTiles.Count,
            scavenged_fraction = grid.GetScavengedTilesFraction(),
            tiles
        };
    }

    private object ReadVehicleMap(JObject args)
    {
        var controller = WorldContainer().Resolve<VehiclesController>();
        var includeUndiscovered = (bool?)args["include_undiscovered"] ?? true;
        var radius = (float?)args["radius"] ?? 0f;
        var limit = (int?)args["limit"] ?? 300;
        if (limit is < 1 or > 1000)
            throw new BridgeException("invalid_limit", "limit must be between 1 and 1000.");
        var origin = HqController.MainHeadquarter != null ? HqController.MainHeadquarter.Position : Vector3.zero;
        var rows = new List<(object row, float distance, bool discovered)>();
        foreach (var vehicle in controller.Vehicles)
        {
            if (vehicle == null) continue;
            var discovered = vehicle.IsDiscovered;
            if (!includeUndiscovered && !discovered) continue;
            var distance = PlanarDistance(origin, vehicle.Position);
            if (radius > 0f && distance > radius) continue;
            var trunk = vehicle.Trunk;
            var fuel = vehicle.Fuel;
            rows.Add((new
            {
                id = vehicle.Id,
                type = vehicle.Type.ToString(),
                state = vehicle.VehicleState.ToString(),
                position = Position(vehicle.Position),
                distance = Mathf.Round(distance),
                discovered,
                owner_group_id = vehicle.Owner == null ? null : vehicle.Owner.Id.ToString(),
                has_driver = vehicle.HasDriver,
                fuel_ratio = fuel.FuelCapacity > 0f ? fuel.FuelQuantity / fuel.FuelCapacity : 0f,
                trunk_load_ratio = trunk.Capacity > 0 ? (float)trunk.GetCratesCount() / trunk.Capacity : 0f,
                cargo = trunk.Resources.Where(item => item.Value > 0f)
                    .ToDictionary(item => item.Key.ToString(), item => item.Value)
            }, distance, discovered));
        }
        var nearest = rows.OrderBy(entry => entry.distance).Take(limit).ToList();
        return new
        {
            count = nearest.Count,
            matched_total = rows.Count,
            truncated = rows.Count > limit,
            undiscovered = nearest.Count(entry => !entry.discovered),
            vehicles = nearest.Select(entry => entry.row).ToList()
        };
    }
}
