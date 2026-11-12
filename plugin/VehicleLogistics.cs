using System.Collections.Generic;
using System.Linq;
using Controllers;
using Gameplay.Buildings;
using Gameplay.Rebuilding;
using Gameplay.Rebuilding.Towers;
using Gameplay.Units.Orders;
using Gameplay.Vehicles;
using Newtonsoft.Json.Linq;

namespace IfzMcp;

public sealed partial class Plugin
{
    private static object ReadVehicle(Vehicle vehicle)
    {
        var trunk = vehicle.Trunk;
        var cargo = trunk.Resources.Where(item => item.Value > 0);
        var used = cargo.Sum(item => trunk.GetCratesCount(item.Key));
        var fuel = vehicle.Fuel;
        return new
        {
            id = vehicle.Id,
            type = vehicle.Type,
            state = vehicle.VehicleState.ToString(),
            position = Position(vehicle.Position),
            owner_group_id = vehicle.Owner == null ? null : vehicle.Owner.Id,
            has_driver = vehicle.HasDriver,
            waiting = vehicle.IsWaiting,
            trunk = new
            {
                occupied_slots = used,
                capacity_slots = trunk.Capacity,
                available_slots = trunk.SpaceLeftInCrates,
                load_ratio = trunk.Capacity > 0 ? (float)used / trunk.Capacity : (float?)null,
                cargo = cargo.ToDictionary(item => item.Key.ToString(), item => item.Value)
            },
            fuel = new
            {
                quantity = fuel.FuelQuantity,
                capacity = fuel.FuelCapacity,
                ratio = fuel.FuelCapacity > 0 ? fuel.FuelQuantity / fuel.FuelCapacity : (float?)null,
                refill_enabled = vehicle.FuelInEnabled
            }
        };
    }

    private static string StockroomId(Structure structure) => structure switch
    {
        Building building => building.Id,
        ConvoyStructure convoy => convoy.Id,
        _ => null
    };

    private static bool IsSharedStockroom(Structure structure) =>
        structure != null && !structure.IsDead() && structure.IsStockroom() &&
        !structure.Draft.IsPrivateStockroom && !string.IsNullOrEmpty(StockroomId(structure));

    private static IEnumerable<Structure> SharedStockrooms()
    {
        var container = WorldContainer();
        return container.Resolve<BuildingsController>().AdaptedBuildings.Cast<Structure>()
            .Concat(container.Resolve<ConvoyStructureController>().ConvoyStructures)
            .Append(HqController.MainHeadquarter)
            .Where(IsSharedStockroom).Distinct();
    }

    private static object ReadStockroom(Structure structure) => new
    {
        id = StockroomId(structure),
        headquarters = structure == HqController.MainHeadquarter,
        position = Position(structure.Position)
    };

    private static object ReturnToStockroom(JObject args, WorldCommand command)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var vehicle = squad.VehicleHandler?.Vehicle;
        var mounted = vehicle != null && vehicle.HasDriver &&
            squad.Characters.Any(member => member != null && !member.IsDead() && member.IsInVehicle);
        var requestedVehicle = args["vehicle_id"] == null ? null : Text(args, "vehicle_id", 64);
        if (requestedVehicle != null && vehicle != null && vehicle.Id != requestedVehicle)
            throw new BridgeException("vehicle_changed", "This squad is using a different vehicle. Read the squad again.");
        if (requestedVehicle != null && !mounted)
            throw new BridgeException("squad_not_mounted", "This squad is not aboard the requested vehicle. Omit vehicle_id to send a walking squad into a stockroom.");
        if (squad.IsOnExpedition())
            throw new BridgeException("squad_unavailable", "Choose a squad on the settlement map.");

        var stockroomId = args["stockroom_id"] == null ? null : Text(args, "stockroom_id", 64);
        var target = stockroomId == null ? HqController.MainHeadquarter :
            SharedStockrooms().FirstOrDefault(room => StockroomId(room) == stockroomId);
        if (!IsSharedStockroom(target) || !squad.CanGoToStructure(target))
            throw new BridgeException("stockroom_unavailable", "Choose an accessible shared stockroom or headquarters.");
        var replace = (bool?)args["replace_orders"] == true;
        if (!replace && !squad.OrdersHandlers.HasNoOrder())
            throw new BridgeException("squad_busy", "Wait for the current order or explicitly replace it.");

        Order order = target is Building building
            ? new MoveToBuildingOrder(building)
            : new MoveToConvoyStructureOrder((ConvoyStructure)target);
        var accepted = TrySubmitSquadOrder(squad, order, replace, command);
        return new
        {
            squad_id = squad.Id,
            mounted,
            vehicle_id = vehicle == null ? null : vehicle.Id,
            stockroom_id = StockroomId(target),
            order = order.GetType().Name,
            state = accepted ? "accepted" : "rejected"
        };
    }

    private static object TakeVehicle(JObject args, WorldCommand command)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var vehicleId = Text(args, "vehicle_id", 64);
        var vehicle = WorldContainer().Resolve<VehiclesController>().GetVehicleById(vehicleId) ??
            throw new BridgeException("vehicle_unavailable", "No current vehicle with that ID.");
        if (!vehicle.IsDiscovered)
            throw new BridgeException("vehicle_unavailable", "Discover the vehicle on the map before ordering a squad to take it.");
        if (vehicle.Owner != null)
            throw new BridgeException("vehicle_owned", "This vehicle already belongs to a squad.");
        if (vehicle.UnderCarWorkshop)
            throw new BridgeException("vehicle_unavailable", "This vehicle is being repaired at a car workshop.");
        if (vehicle.VehicleState == Vehicle.VehicleStates.InRepair)
            throw new BridgeException("vehicle_unavailable", "This vehicle cannot be taken while it is under repair.");
        if (squad.VehicleHandler.HaveVehicle())
            throw new BridgeException("squad_has_vehicle", "This squad already uses a vehicle. Choose a walking squad.");
        if (squad.IsOnExpedition())
            throw new BridgeException("squad_unavailable", "Choose a squad on the settlement map.");
        var replace = (bool?)args["replace_orders"] == true;
        if (!replace && !squad.OrdersHandlers.HasNoOrder())
            throw new BridgeException("squad_busy", "Wait for the current order or explicitly replace it.");

        var order = new TakeVehicleOrder(vehicle);
        var accepted = TrySubmitSquadOrder(squad, order, replace, command);
        return new
        {
            squad_id = squad.Id,
            vehicle_id = vehicle.Id,
            vehicle_type = vehicle.Type,
            vehicle_state = vehicle.VehicleState.ToString(),
            position = Position(vehicle.Position),
            order = order.GetType().Name,
            state = accepted ? "accepted" : "rejected"
        };
    }
}
