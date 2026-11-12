using System;
using System.Collections.Generic;
using System.Linq;
using Controllers;
using Data.Resorces;
using Gameplay.Buildings;
using Gameplay.GameResources;
using Gameplay.Units;
using Gameplay.Units.Characters;
using Gameplay.Units.Enemy;
using Gameplay.Units.Equipment;
using Gameplay.Units.Orders;
using Gameplay.Units.Virtual;
using Gameplay.Units.Player.Workers.WorkSystem;
using MapEssentials;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Utilities;

namespace IfzMcp;

public sealed partial class Plugin
{
    private readonly Dictionary<Guid, WorldCommand> worldCommands = new();
    private readonly Queue<Guid> finishedWorldCommands = new();

    private void RequirePausedWorld()
    {
        if (step != null || !pauses.IsOnlyGameplayPaused)
            throw new BridgeException("pause_required", "Apply gameplay pause and close any blocking popup first.");
    }

    private object ExecuteWorldCommand(string method, JObject args)
    {
        var id = Id(args, "request_id");
        var input = (JObject)args.DeepClone();
        input.Remove("lease");
        if (worldCommands.TryGetValue(id, out var previous))
        {
            if (previous.Method != method || !JToken.DeepEquals(previous.Input, input))
                throw new BridgeException("request_conflict", "The request_id was used with different arguments.");
            if (previous.Result == null)
                throw new BridgeException("result_unknown", "Read game state before attempting another write.");
            return previous.Result;
        }
        if (method != "choose_dialogue_option" && method != "cancel_squad_order" && method != "update_work_task" &&
            method != "queue_construction" && method != "set_facility_production" && method != "set_facility_defense_weapon")
            RequirePausedWorld();
        var command = new WorldCommand(method, input);
        worldCommands.Add(id, command);
        try
        {
            command.Result = method switch
            {
                "move_npc_group" => MoveNpcGroup(args),
                "attack_group" => AttackGroup(args, command),
                "set_building_workers" => SetBuildingWorkers(args),
                "update_work_task" => UpdateWorkTask(args),
                "queue_construction" => QueueConstruction(args),
                "set_facility_production" => SetFacilityProduction(args),
                "set_facility_defense_weapon" => SetFacilityDefenseWeapon(args),
                "equip_squad_member" => EquipMember(args),
                "refill_squad_member_ammo" => RefillMemberAmmo(args),
                "scavenge_building" => ScavengeBuilding(args, command),
                "return_to_stockroom" => ReturnToStockroom(args, command),
                "take_vehicle" => TakeVehicle(args, command),
                "cancel_squad_order" => CancelSquadOrder(args),
                "choose_dialogue_option" => ChooseRadioOption(args),
                "cheat_apply" => ApplyGroupedCheat(args),
                _ => throw new BridgeException("unknown_method", "Unknown world command.")
            };
            return command.Result;
        }
        catch (BridgeException)
        {
            worldCommands.Remove(id);
            throw;
        }
        finally
        {
            if (worldCommands.ContainsKey(id))
            {
                finishedWorldCommands.Enqueue(id);
                if (finishedWorldCommands.Count > RecentOrderLimit)
                    worldCommands.Remove(finishedWorldCommands.Dequeue());
            }
        }
    }

    private static Group FindSquad(string id)
    {
        var squad = squads.Squads.FirstOrDefault(item => item != null && !item.IsDestroying && item.Id == id);
        return squad ?? throw new BridgeException("squad_unavailable", "No active player squad with that ID.");
    }

    private static Character FindMember(Group squad, string id)
    {
        var member = squad.Characters.FirstOrDefault(item => item != null && !item.IsDead() && item.Id == id);
        return member ?? throw new BridgeException("member_unavailable", "No living member with that ID in this squad.");
    }

    private static Group FindNpcGroup(string id)
    {
        var group = WorldContainer().Resolve<GroupsController>().Groups
            .FirstOrDefault(item => item != null && item.Id == id && !item.IsDestroying && !item.IsEmpty());
        return group ?? throw new BridgeException("group_unavailable", "No active nonplayer group with that ID.");
    }

    private static Building FindBuilding(string id)
    {
        var buildings = WorldContainer().Resolve<BuildingsController>().BuildingsToId;
        if (long.TryParse(id, out var number) && buildings.TryGetValue(number, out var building) && building != null)
            return building;
        throw new BridgeException("building_unavailable", "No current building with that ID.");
    }

    private static WorkBase BuildingWork(Building building) =>
        building.CurrentWork ?? (WorkBase)building.BuildWork ?? building.DefenseWork;

    private static object ReadWorksite(Building building)
    {
        var work = BuildingWork(building);
        return new
        {
            building_id = building.Id,
            position = Position(building.CenterPosition),
            work = work.GetType().Name,
            workers = work.Workers.Count,
            max_workers = work.MaxWorkers,
            initial_max_workers = work.InitialMaxWorkers
        };
    }

    private static object SetBuildingWorkers(JObject args)
    {
        var building = FindBuilding(Text(args, "building_id", 64));
        var work = BuildingWork(building) ??
            throw new BridgeException("work_unavailable", "This building has no active work.");
        var expected = (int?)args["expected_max_workers"];
        var target = (int?)args["max_workers"];
        if (!expected.HasValue || expected < 0 || !target.HasValue || target < 0 || target > work.InitialMaxWorkers)
            throw new BridgeException("invalid_workers", "Use a worker limit within the site's original capacity.");
        var beforeLimit = work.MaxWorkers;
        var beforeWorkers = work.Workers.Count;
        if (beforeLimit != target && beforeLimit != expected)
            throw new BridgeException("workers_changed", "Read worksites again before assigning workers.");
        if (beforeLimit != target.Value)
            work.MaxWorkers = target.Value;
        return new
        {
            building_id = building.Id, before_workers = beforeWorkers, workers = work.Workers.Count,
            before_max_workers = beforeLimit, max_workers = work.MaxWorkers
        };
    }

    private static Vector3 FindGround(Vector3 requested)
    {
        WorldContainer();
        var nearest = PathfindingUtils.GetNearestOnGround(requested);
        if (nearest.node == null || !nearest.node.Walkable || PlanarDistance(nearest.position, requested) > 6f)
            throw new BridgeException("no_walkable_point", "Choose a point within six world units of the ground navigation mesh.");
        return nearest.position;
    }

    private static object ReadNavigationPoint(JObject args)
    {
        var point = new Vector3(Coordinate(args, "x"), Coordinate(args, "y"), Coordinate(args, "z"));
        var ground = FindGround(point);
        var node = PathfindingUtils.GetNearestOnGround(ground).node;
        return new { position = Position(ground), snap_distance = PlanarDistance(point, ground), area = node.Area };
    }

    private static object MoveNpcGroup(JObject args)
    {
        var id = Text(args, "group_id", 64);
        var x = Coordinate(args, "x");
        var z = Coordinate(args, "z");
        if ((bool?)args["virtual"] == true)
        {
            var virtualGroup = WorldContainer().Resolve<VirtualGroupsController>().Get(id);
            if (virtualGroup == null || virtualGroup.IsEmpty())
                throw new BridgeException("group_unavailable", "No active virtual group with that ID.");
            if (!worldMap.BoundExtend.Contains(new Vector2(x, z)))
                throw new BridgeException("target_out_of_range", "Choose a point within the expedition map.");
            var destination = new Vector3(x, virtualGroup.Position.y, z);
            virtualGroup.MoveTo(destination);
            return new { group_id = id, state = "submitted", target = Position(destination) };
        }

        var group = FindNpcGroup(id);
        var target = FindGround(new Vector3(x, group.Position.y, z));
        group.MoveTo(target);
        return new { group_id = id, state = "submitted", target = Position(target),
            destination = Position(group.Movement.Destination) };
    }

    private static object AttackGroup(JObject args, WorldCommand command)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var id = Text(args, "group_id", 64);
        var replace = (bool?)args["replace_orders"] == true;
        var target = FindAttackTarget(squad, id, (bool?)args["virtual"] == true);
        Order order = target is VirtualGroup virtualGroup ? new AttackVirtualGroupOrder(virtualGroup) : new AttackGroupOrder((Group)target);
        return SubmitSquadOrder(squad, order, replace, id, command);
    }

    private static object ScavengeBuilding(JObject args, WorldCommand command)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var building = FindBuilding(Text(args, "building_id", 64));
        if (squad.IsOnExpedition() || !building.CanScavenge() || building.IsScavenged() ||
            !squad.CanGoToStructure(building))
            throw new BridgeException("scavenge_unavailable", "This squad cannot scavenge the selected building.");
        return SubmitSquadOrder(squad, new MoveToBuildingOrder(building),
            (bool?)args["replace_orders"] == true, building.Id, command);
    }

    private static object SubmitSquadOrder(Group squad, Order order, bool replace, string targetId, WorldCommand command)
    {
        var accepted = TrySubmitSquadOrder(squad, order, replace, command);
        return new { squad_id = squad.Id, target_id = targetId, order = order.GetType().Name,
            state = accepted ? "accepted" : "rejected" };
    }

    private static bool TrySubmitSquadOrder(Group squad, Order order, bool replace, WorldCommand command)
    {
        command.NativeOrder = order;
        squad.OrdersHandlers.GiveOrder(order, clearOrders: replace);
        var queue = squad.OrdersHandlers.OrdersQueue;
        var accepted = ReferenceEquals(queue.CurrentOrder, order) || queue.Orders.Contains(order);
        if (!accepted)
            order.Dispose();
        return accepted;
    }

    private object CancelSquadOrder(JObject args)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var id = Id(args, "order_id");
        moves.TryGetValue(id, out var move);
        worldCommands.TryGetValue(id, out var command);
        var order = (Order)move?.NativeOrder ?? command?.NativeOrder;
        if (order == null || !ReferenceEquals(order.Group, squad))
            throw new BridgeException("order_not_found", "No tracked order with that ID for this squad.");

        var queue = squad.OrdersHandlers.OrdersQueue;
        if (!ReferenceEquals(queue.CurrentOrder, order) && !queue.Orders.Contains(order))
            throw new BridgeException("order_not_active", "The tracked order already ended or was replaced.");

        // End only the recorded order. The player may have added other orders since submission.
        queue.RemoveFromQueue(order);
        if (move != null) move.State = "canceled";
        queue.UpdatePath();
        return new { squad_id = squad.Id, order_id = id, state = "canceled",
            active_order = queue.CurrentOrder?.GetType().Name,
            queued_orders = queue.Orders.Select(item => item.GetType().Name).ToArray() };
    }

    private static ResourcesContainer EquipmentSource(Group squad, JObject args) =>
        Text(args, "source", 16) switch
        {
            "cargo" => squad.ResourcesContainer,
            "stockpile" => WorldContainer().Resolve<StockroomsController>().Container,
            _ => throw new BridgeException("invalid_source", "Use squad cargo or shared stockpile.")
        };

    private static object EquipMember(JObject args)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var member = FindMember(squad, Text(args, "member_id", 64));
        var source = EquipmentSource(squad, args);
        var name = Text(args, "weapon_id", 64);
        if (!Enum.TryParse<ResourceID>(name, out var id) || name != id.ToString() ||
            !ResourcesDataContainer.Instance.IsWeapon(id) ||
            ResourcesDataContainer.Instance.GetResourceDataByType(id) is not Weapon weapon ||
            weapon.AccessoryUseOnly || weapon.IsDefaultMeleeWeapon())
            throw new BridgeException("invalid_weapon", "Choose an equippable weapon resource.");
        var handler = member.ItemsContainer.WeaponHandler;
        var before = handler.CurrentWeapon.ResourceType;
        if (before != id)
        {
            if (source.GetAvailableResourceQuantity(id) < 1f || !source.TryRemoveResource(id, 1f))
                throw new BridgeException("weapon_unavailable", "The selected source needs one available weapon.");
            handler.AssignWeapon(weapon);
        }
        return new { member_id = member.Id, before = before.ToString(), weapon_id = handler.CurrentWeapon.ResourceType.ToString() };
    }

    private static object RefillMemberAmmo(JObject args)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var member = FindMember(squad, Text(args, "member_id", 64));
        var handler = member.ItemsContainer.AmmunitionHandler;
        var before = handler.Ammunition.Quantity;
        handler.RefillAmmoFromContainer(EquipmentSource(squad, args));
        return new { member_id = member.Id, ammo_id = handler.Ammunition.ResourceID.ToString(), before,
            amount = handler.Ammunition.Quantity };
    }

    private sealed class WorldCommand
    {
        public readonly string Method;
        public readonly JObject Input;
        public object Result;
        public Order NativeOrder;

        public WorldCommand(string method, JObject input)
        {
            Method = method;
            Input = input;
        }
    }
}
