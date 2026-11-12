using System;
using System.Collections.Generic;
using System.Linq;
using Commands;
using Controllers;
using Controllers.CharacterLogic;
using Data.Resorces;
using EventsSystem;
using Gameplay.GameResources;
using Gameplay.Units;
using Gameplay.Units.Characters;
using Gameplay.Units.Enemy;
using Gameplay.Units.Equipment;
using Gameplay.Units.Player.Workers;
using HarmonyLib;
using MapEssentials;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Zenject;

namespace IfzMcp;

public sealed partial class Plugin
{
    private static GameManager worldManager;
    private static DiContainer worldContainer;
    private static Map worldMap;

    private static void CaptureWorld(Harmony harmony)
    {
        harmony.Patch(AccessTools.Method(typeof(GameManager), nameof(GameManager.Initialize)),
            postfix: new HarmonyMethod(typeof(Plugin), nameof(OnWorldInitialized)));
    }

    private static void OnWorldInitialized(GameManager __instance, DiContainer ____diContainer, Map map)
    {
        worldManager = __instance;
        worldContainer = ____diContainer;
        worldMap = map;
    }

    private static DiContainer WorldContainer()
    {
        if (worldManager == null || worldContainer == null || worldMap?.Generated != true)
            throw new BridgeException("world_not_ready", "Wait for the settlement map to finish loading.");
        return worldContainer;
    }

    private object ReadWorld(JObject args)
    {
        var (offset, limit) = PageRange(args);
        var container = WorldContainer();
        var category = Text(args, "category", 32);

        IEnumerable<object> rows = category switch
        {
            "squads" => squads.Squads.Where(group => group != null && !group.IsDestroying).Select(group => ReadGroup(group)),
            "citizens" => container.Resolve<CitizensController>().Citizens
                .Where(character => character != null && character.CharacterInfo != null).Select(ReadCharacter),
            "workers" => container.Resolve<WorkersController>().Workers
                .Where(character => character != null && character.CharacterInfo != null).Select(ReadCharacter),
            "groups" => container.Resolve<GroupsController>().Groups
                .Where(group => group != null && !group.IsDestroying)
                .Select(group => ReadGroup(group, group.IsVisible() && group.CanBeAttacked() &&
                    squads.Squads.Any(squad => squad != null && !squad.IsDestroying && squad.EnemiesProvider.IsEnemy(group)))),
            "virtual_groups" => container.Resolve<VirtualGroupsController>().Groups.Where(group => group != null)
                .Select(group => new
                {
                    id = group.ID,
                    type = group.Type,
                    faction = group.Fraction.ToString(),
                    position = Position(group.Position),
                    destination = Position(group.Movement.Target),
                    visible = group.IsVisible(),
                    hostile_to_player = group.IsVisible() && squads.Squads.Any(squad =>
                        squad != null && !squad.IsDestroying && squad.EnemiesProvider.IsEnemy(group)),
                    member_count = group.ICharacters.Count
                }),
            "worksites" => container.Resolve<BuildingsController>().Buildings
                .Where(building => building != null && BuildingWork(building) != null).Select(ReadWorksite),
            "vehicles" => container.Resolve<VehiclesController>().Vehicles
                .Where(vehicle => vehicle != null && (vehicle.IsDiscovered || vehicle.Owner?.Fraction == Fraction.Player))
                .Select(ReadVehicle),
            "stockrooms" => SharedStockrooms().Select(ReadStockroom),
            "ground_resources" => container.Resolve<ResourcesController>().Resources.Values
                .Where(resource => resource != null && !resource.IsDestroying && resource.Character == null)
                .Select(resource => new
                {
                    id = resource.ID,
                    position = Position(resource.Position),
                    resource_id = resource.ResourceCrate.ResourceID.ToString(),
                    quantity = resource.ResourceCrate.Quantity
                }),
            "stockpile" => ReadStockpile(container.Resolve<StockroomsController>()),
            "events" => ReadEvents(container),
            "resource_types" => GameConsoleCommandHandler.GetPublicResourceIds()
                .Where(IsEditableStockResource).Select(id => new { resource_id = id }),
            "map" => new[] { new
            {
                city = worldMap.CityName,
                tile = Map.GetTileInfo(),
                bounds = Bounds(Map.Bound),
                raw_bounds = Bounds(Map.RawBound),
                tile_size = worldMap.TileSize
            } },
            "weapons" => ResourcesDataContainer.Instance.Resources.OfType<Weapon>()
                .Select(weapon => new
                {
                    id = weapon.ResourceType.ToString(),
                    melee = weapon.IsMelee,
                    ammo_id = weapon.AmmoDraft?.ResourceType.ToString(),
                    magazine_capacity = weapon.magazineCapacity
                }),
            _ => throw new BridgeException("unknown_category", "Unknown world data category.")
        };

        return ReadPage(category, offset, limit, rows);
    }

    private static (int offset, int limit) PageRange(JObject args)
    {
        var offset = (int?)args["offset"] ?? 0;
        var limit = (int?)args["limit"] ?? 40;
        if (offset < 0 || limit is < 1 or > 100)
            throw new BridgeException("invalid_page", "Use a nonnegative offset and a limit of 1–100.");
        return (offset, limit);
    }

    private object ReadPage(string category, int offset, int limit, IEnumerable<object> rows)
    {
        var page = rows.Skip(offset).Take(limit + 1).ToArray();
        return new
        {
            session_id = sessionId,
            category,
            offset,
            next_offset = page.Length > limit ? (int?)checked(offset + limit) : null,
            items = page.Take(limit).ToArray()
        };
    }

    private static IEnumerable<object> ReadEvents(DiContainer container)
    {
        var markers = container.Resolve<MarkersController>();
        var controller = container.Resolve<EventsSystemController>();
        var missions = controller.ActiveMissions
            .Where(mission => mission != null)
            .Select(mission => new
            {
                kind = "mission",
                id = mission.Id,
                title_key = mission.customDescription ? mission.customDescriptionId : mission.Id + "_title",
                objectives = mission.ObjectiveExpressions.Where(row => row?.objective != null)
                    .Select(row => new
                    {
                        id = row.objective.Id,
                        type = row.objective.ObjectiveType.ToString(),
                        completed = row.objective.Completed
                    }).ToArray(),
                markers = markers.GetMarkersByMissionId(mission.Id).OfType<EventMarker>()
                    .Where(marker => marker != null && marker.gameObject.activeInHierarchy)
                    .Select(marker => Position(marker.Position)).ToArray()
            }).Cast<object>();
        return missions.Concat(controller.ActiveEvents.Where(item => item != null)
            .Select(item => new { kind = "event", id = item.Id }));
    }

    private static object ReadGroup(Group group, bool hostile = false) => new
    {
        id = group.Id,
        name = group.GroupName,
        type = group.Type,
        faction = group.Fraction.ToString(),
        position = Position(group.Position),
        destination = Position(group.Movement.Destination),
        vehicle_id = group.VehicleHandler?.Vehicle == null ? null : group.VehicleHandler.Vehicle.Id,
        waiting_vehicle_id = group.VehicleHandler?.VehicleWaiting == null ? null : group.VehicleHandler.VehicleWaiting.Id,
        active_order = group.OrdersHandlers?.OrdersQueue.CurrentOrder?.GetType().Name,
        queued_orders = group.OrdersHandlers?.OrdersQueue.Orders.Select(order => order.GetType().Name).ToArray(),
        visible = group.IsVisible(),
        hostile_to_player = hostile,
        weapon_id = group.Weapon?.ResourceType.ToString(),
        cargo = group.ResourcesContainer.Resources.Where(item => item.Value > 0)
            .ToDictionary(item => item.Key.ToString(), item => item.Value),
        member_count = group.Characters.Count,
        members = group.Characters.Where(character => character != null && character.CharacterInfo != null)
            .Take(32).Select(ReadCharacter).ToArray()
    };

    private static object ReadCharacter(Character character) => new
    {
        id = character.Id,
        name = character.Name,
        type = character.Type.ToString(),
        child = character.IsChild,
        group_id = character.Group?.Id,
        position = Position(character.Position),
        hp = character.Health?.Hp,
        max_hp = character.Health?.MaxHp,
        job = character.WorkModule?.CurrentWork?.GetType().Name,
        weapon_id = character.ItemsContainer?.WeaponHandler?.CurrentWeapon?.ResourceType.ToString(),
        ammo = character.ItemsContainer?.AmmunitionHandler?.Ammunition.Quantity
    };

    private static IEnumerable<object> ReadStockpile(StockroomsController stockrooms) =>
        ReadContainer(stockrooms.Container, "physical")
            .Concat(ReadContainer(stockrooms.VirtualResourcesContainer, "virtual"));

    private static IEnumerable<object> ReadContainer(ResourcesContainer container, string storage) =>
        container.Resources.Where(item => item.Value > 0)
            .Select(item => new
            {
                storage,
                resource_id = item.Key.ToString(),
                quantity = item.Value,
                available = container.GetAvailableResourceQuantity(item.Key)
            });

    private static object Bounds(Rect rect) => new
    {
        min_x = rect.xMin, min_z = rect.yMin, max_x = rect.xMax, max_z = rect.yMax
    };

    private object SetStockpileAmount(JObject args)
    {
        RequirePausedWorld();
        var stockpile = WorldContainer().Resolve<StockroomsController>().Container;
        var name = Text(args, "resource_id", 64);
        if (!GameConsoleCommandHandler.GetPublicResourceIds().Contains(name) || !IsEditableStockResource(name))
            throw new BridgeException("unsupported_resource", "Choose an ID from resource_types.");
        var resourceId = Enum.Parse<ResourceID>(name);
        var expected = StockQuantity(args, "expected_amount");
        var target = StockQuantity(args, "amount");
        var before = stockpile.GetResourceQuantity(resourceId);
        if (before == target)
            return new { resource_id = resourceId.ToString(), before, amount = before, changed = false };
        if (before != expected)
            throw new BridgeException("stock_changed", "Read the stockpile again before setting its amount.");

        var applied = target > before
            ? stockpile.AddResource(resourceId, target - before, ResourceAddReason.None)
            : stockpile.TryRemoveResource(resourceId, before - target);
        if (!applied)
            throw new BridgeException("stock_rejected", "The stockpile capacity or available quantity rejected the edit.");
        var amount = stockpile.GetResourceQuantity(resourceId);
        return new { resource_id = resourceId.ToString(), before, amount, changed = amount != before };
    }

    private static bool IsEditableStockResource(string name) =>
        name != nameof(ResourceID.res_scientificmaterial);

    private static float StockQuantity(JObject args, string key)
    {
        var value = (float?)args[key];
        if (!value.HasValue || !float.IsFinite(value.Value) || value.Value is < 0 or > 1000000)
            throw new BridgeException("invalid_amount", "Stockpile amounts must be between 0 and 1000000.");
        return value.Value;
    }
}
