using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Controllers;
using Controllers.Time;
using Controllers.Weather;
using Data.Building;
using Gameplay.Buildings;
using Gameplay.GameResources;
using Gameplay.Mood;
using Gameplay.Rebuilding;
using Gameplay.Rebuilding.CustomBuildings;
using Gameplay.Rebuilding.Split;
using Gameplay.Rebuilding.StateMachine;
using Gameplay.Rebuilding.Towers;
using JutsuGamesConfig.Runtime;
using MapEssentials;
using MapOperator.Runtime.Data;
using MapOperator.Runtime.Utils.Extensions;
using MapOperator.Runtime.Utils.Geometry;
using Newtonsoft.Json.Linq;
using StoresHelper;
using UnityEngine;
using Utilities;
using Utilities.Extensions;
using Zenject;

namespace IfzMcp;

public sealed partial class Plugin
{
    private const string CustomConstructionUnlock = "CustomBuildingConstruction";
    private static readonly Dictionary<FacadeType, string> FacadeUnlocks = new()
    {
        [FacadeType.wood] = "wood", [FacadeType.wood_only] = "wood_only", [FacadeType.bricks] = "bricks",
        [FacadeType.plaster] = "plaster", [FacadeType.cementBlocks] = "cement_blocks", [FacadeType.stone] = "cement_blocks",
        [FacadeType.metal] = "metal", [FacadeType.metal_only] = "metal_only"
    };
    private ConstructionOrder pendingConstruction;

    private sealed class ConstructionPlan
    {
        public PlaceableObjectDraft Draft;
        public Building Existing;
        public Vector2[] Footprint;
        public float Height;
        public FacadeType Facade;
        public List<string> Blockers = new();
        public object Preview;
    }

    private sealed class ConstructionOrder
    {
        private readonly Task<Building> task;
        public Guid request_id { get; }
        public string state => !task.IsCompleted ? "placing" : task.IsCompletedSuccessfully ? "queued" : "result_unknown";
        public string building_id => task.IsCompletedSuccessfully && task.Result != null ? task.Result.Id : null;

        public ConstructionOrder(Guid id, Task<Building> task)
        {
            request_id = id;
            this.task = task;
        }
    }

    private static IEnumerable<PlaceableObjectDraft> ConstructionDrafts()
    {
        var data = BuildingsDatas.Instance;
        for (var i = 0; i < data.BuildingMenuSectionCount; i++)
        {
            var section = data.GetBuildingMenuSection(i);
            for (var j = 0; j < section.PlaceableObjectCount; j++)
            {
                var draft = section.GetPlaceableObject(j);
                if (draft.PlaceableObjectType == PlaceableObjectType.AdoptBuilding && !draft.IsHq)
                    yield return draft;
            }
        }
    }

    private static bool ConstructionTypeUnlocked(PlaceableObjectDraft draft)
    {
        var content = SaveHandler.SaveData.ContentStateController;
        return (!draft.IsUnlockedByDLC || DlcHelper.IsInstalled(draft.UnlockingDLC)) &&
            (!content.IsContent(draft.Id, out var state) || state.Unlocked);
    }

    private static bool FacadeUnlocked(FacadeType facade) =>
        SaveHandler.SaveData.ContentStateController.IsContentUnlocked("CustomBuilding_Facade_" + FacadeUnlocks[facade]);

    private static object ReadConstructionCatalog()
    {
        WorldContainer();
        var config = Configs.GetConfig<CustomBuildingConfig>();
        return new
        {
            new_building_unlocked = SaveHandler.SaveData.ContentStateController.IsContentUnlocked(CustomConstructionUnlock),
            new_building_research_id = CustomConstructionUnlock,
            minimum_wall_m = config.MinWallLength,
            minimum_footprint_m2_exclusive = config.MinSurface,
            maximum_footprint_m2_exclusive = config.MaxSurface,
            minimum_height_m = config.MinBuildingHeight,
            maximum_height_m = config.MaxBuildingHeight,
            building_clearance_m = config.MinDistanceFromOtherBuilding,
            facades = FacadeUnlocks.Keys.Select(facade => new { id = facade.ToString(), unlocked = FacadeUnlocked(facade) }).ToArray(),
            types = ConstructionDrafts().GroupBy(draft => draft.Id).Select(group => group.First()).Select(draft => new
            {
                type_id = draft.Id,
                name = draft.GetNameBuilding(),
                unlocked = ConstructionTypeUnlocked(draft),
                supported = !draft.HasCarWorkshopModule,
                workplace_capacity_per_100_m3 = draft.HasWorkersModule ? draft.MaxWorkers : 0f,
                recipes = draft.ProductionsData?.productions?.Select(recipe => recipe.Id).ToArray() ?? Array.Empty<string>()
            }).ToArray()
        };
    }

    private static ConstructionPlan PlanConstruction(JObject args)
    {
        var container = WorldContainer();
        var config = Configs.GetConfig<CustomBuildingConfig>();
        var kind = Text(args, "kind", 12);
        if (kind != "new" && kind != "adapt") throw new BridgeException("invalid_construction_kind", "Choose new or adapt.");
        var typeId = Text(args, "type_id", 80);
        var draft = ConstructionDrafts().FirstOrDefault(row => row.Id == typeId);
        if (draft == null) throw new BridgeException("unknown_construction_type", "Use a type_id from get_construction_catalog.");

        var plan = new ConstructionPlan { Draft = draft };
        var buildings = container.Resolve<BuildingsController>();
        var stock = container.Resolve<StockroomsController>();
        var cost = new Dictionary<ResourceID, int>();
        if (!ConstructionTypeUnlocked(draft)) plan.Blockers.Add("building_type_locked");
        if (draft.HasCarWorkshopModule) plan.Blockers.Add("garage_entrance_required");
        var maxDistance = (float?)args["max_distance_to_owned_m"] ?? 200f;
        if (!float.IsFinite(maxDistance) || maxDistance <= 0)
            throw new BridgeException("invalid_distance", "Use a positive max_distance_to_owned_m.");

        Vector3 center;
        float area;
        float volume;
        float width;
        float length;
        int builders;
        float constructionWork;
        object terrain = null;
        string[] blockingBuildings = Array.Empty<string>();
        if (kind == "adapt")
        {
            var building = FindBuilding(Text(args, "building_id", 64));
            plan.Existing = building;
            center = building.CenterPosition;
            width = building.AABB.width;
            length = building.AABB.height;
            area = (float)building.RawBuilding.Data.Surface;
            plan.Height = building.Height;
            volume = building.Volume;
            if (!building.CanAdapt || building.IsHideout() || building.IsNpcStructure)
                plan.Blockers.Add("building_not_adaptable");
            builders = Mathf.Max(1, (int)(draft.MaxBuildingWorkers * volume / 100f));
            constructionWork = draft.BuildingTimeGts * builders;
        }
        else
        {
            if (!SaveHandler.SaveData.ContentStateController.IsContentUnlocked(CustomConstructionUnlock))
                plan.Blockers.Add("custom_construction_locked");
            width = ConstructionDimension(args, "width_m");
            length = ConstructionDimension(args, "length_m");
            plan.Height = ConstructionDimension(args, "height_m");
            center = new Vector3(Coordinate(args, "x"), 0f, Coordinate(args, "z"));
            var angle = (float?)args["rotation_degrees"] ?? 0f;
            if (!float.IsFinite(angle) || Math.Abs(angle) > 360f)
                throw new BridgeException("invalid_rotation", "Use a rotation between -360 and 360 degrees.");
            var facade = (string)args["facade"];
            plan.Facade = FacadeType.wood;
            if (facade == null)
            {
                var unlocked = FacadeUnlocks.Keys.FirstOrDefault(FacadeUnlocked);
                if (unlocked != FacadeType.none) plan.Facade = unlocked;
            }
            else if (!Enum.TryParse(facade, out plan.Facade) || !FacadeUnlocks.ContainsKey(plan.Facade))
            {
                throw new BridgeException("invalid_facade", "Use a facade ID from get_construction_catalog.");
            }
            if (!FacadeUnlocked(plan.Facade)) plan.Blockers.Add("facade_locked");
            var rotation = Quaternion.Euler(0f, angle, 0f);
            var corners = new[] { new Vector3(-width, 0, -length), new Vector3(width, 0, -length),
                new Vector3(width, 0, length), new Vector3(-width, 0, length) };
            var points = corners.Select(corner => center + rotation * (corner / 2f)).ToArray();
            plan.Footprint = points.Select(point => new Vector2(point.x, point.z)).ToArray();
            area = width * length;
            volume = area * plan.Height;
            if (points.Any(point => !Map.Bound.Contains(new Vector2(point.x, point.z))))
                plan.Blockers.Add("outside_map");
            else
            {
                for (var i = 0; i < points.Length; i++) points[i] = points[i].UnitySampleHeight();
                center = center.UnitySampleHeight();
                var centerNode = PathfindingUtils.GetNearestXZ(center).node;
                if (centerNode == null || centerNode.IsWaterNode()) plan.Blockers.Add("unwalkable_or_water");
                if (area <= config.MaxSurface && Math.Min(width, length) >= config.MinWallLength)
                    terrain = ReadConstructionTerrain(points, width, length, config.MaxSlopeAngle, plan.Blockers);
                var data = new CustomBuildingData(config);
                data.SetPoints(points);
                data.SetIsClosed(true);
                if (!data.IsValid) plan.Blockers.Add("footprint_" + data.InValidReason);
                var minHeight = Mathf.Max(config.MinBuildingHeight, points.Max(p => p.y) - points.Min(p => p.y) + 1f);
                if (plan.Height < minHeight || plan.Height > Mathf.Max(minHeight, config.MaxBuildingHeight))
                    plan.Blockers.Add("height_outside_site_limits");
                blockingBuildings = CheckConstructionCollisions(buildings, points, plan.Footprint, config.MinDistanceFromOtherBuilding, plan.Blockers);
            }
            foreach (var pair in config.GetCreationCost(plan.Facade, plan.Height, area)) cost[pair.Key.ResourceType] = (int)pair.Value;
            builders = Mathf.Max(1, (int)(config.MaxWorkers * volume / 100f));
            constructionWork = config.TimeToConstructGts * builders + draft.BuildingTimeGts * Mathf.Max(1, (int)(draft.MaxBuildingWorkers * volume / 100f));
        }

        Building.GetBuildingCostForDraft(volume, draft, ref cost);
        var hq = HqController.MainHeadquarter;
        var nearest = buildings.AdaptedBuildings.Cast<Structure>()
            .Concat(container.Resolve<ConvoyStructureController>().ConvoyStructures)
            .Append(hq)
            .Where(row => row != null && row != plan.Existing && (row == hq || (row.IsDone && !row.IsNpcStructure)))
            .Select(row => new { structure = row, distance = PlanarDistance(row is Building building ? building.CenterPosition : row.Position, center) })
            .OrderBy(row => row.distance).FirstOrDefault();
        var distance = nearest?.distance;
        if (distance == null || distance > maxDistance) plan.Blockers.Add("too_far_from_owned_building");
        var capacity = draft.HasWorkersModule ? ProductionsData.GetMaxWorkers(draft.MaxWorkers, volume * 0.01f) : 0;
        var workers = (int?)args["production_workers"] ?? capacity;
        if (workers < 0 || workers > capacity) plan.Blockers.Add("production_workers_exceed_capacity");
        plan.Preview = new
        {
            kind, type_id = draft.Id, name = draft.GetNameBuilding(), building_id = plan.Existing?.Id,
            valid = plan.Blockers.Count == 0, blockers = plan.Blockers.Distinct().ToArray(),
            center = Position(center), footprint = plan.Footprint?.Select(point => new { x = point.x, z = point.y }).ToArray(),
            width_m = width, length_m = length, height_m = plan.Height, footprint_m2 = area, volume_m3 = volume,
            facade = plan.Existing == null ? plan.Facade.ToString() : null,
            terrain,
            nearest_owned_building_id = nearest?.structure.GetId(), nearest_owned_type = nearest?.structure.Draft?.Id,
            distance_to_owned_m = distance, max_distance_to_owned_m = maxDistance,
            distance_to_hq_m = hq == null ? (float?)null : PlanarDistance(hq.Position, center),
            blocking_building_ids = blockingBuildings,
            builders_capacity = builders, base_construction_game_hours_at_capacity = ToGameHours(constructionWork / builders),
            materials = cost.Select(pair => new { resource_id = pair.Key.ToString(), required = pair.Value,
                available = stock.GetResourceQuantity(pair.Key) }).ToArray(),
            workplace_capacity = capacity, production_workers = workers,
            residents_capacity = draft.HasLivingQuartersModule ? draft.GetLivingCapacity(volume, 1f) : 0,
            storage_capacity = draft.HasStorageModule ? draft.GetCapacity(volume, 1f) : 0,
            recipes = ReadProductionRecipes(container, draft, workers, capacity)
        };
        return plan;
    }

    private static float ConstructionDimension(JObject args, string name)
    {
        var value = (float?)args[name];
        if (value == null || !float.IsFinite(value.Value) || value <= 0 || value > 1000)
            throw new BridgeException("invalid_dimensions", "Use positive dimensions in meters, at most 1000 per axis.");
        return value.Value;
    }

    private static object ReadConstructionTerrain(Vector3[] corners, float width, float length, float slopeLimit, List<string> blockers)
    {
        var cols = Mathf.CeilToInt(width);
        var rows = Mathf.CeilToInt(length);
        var water = 0;
        var steep = 0;
        var maxSlope = 0f;
        var minHeight = float.PositiveInfinity;
        var maxHeight = float.NegativeInfinity;
        for (var row = 0; row <= rows; row++)
        {
            var left = Vector3.Lerp(corners[0], corners[3], (float)row / rows);
            var right = Vector3.Lerp(corners[1], corners[2], (float)row / rows);
            for (var col = 0; col <= cols; col++)
            {
                var point = Vector3.Lerp(left, right, (float)col / cols);
                point.y = Map.Mapper.GetTerrainHeight(point, out var normal);
                minHeight = Mathf.Min(minHeight, point.y);
                maxHeight = Mathf.Max(maxHeight, point.y);
                if (HasWaterSurface(point)) water++;
                var slope = Vector3.Angle(normal, Vector3.up);
                maxSlope = Mathf.Max(maxSlope, slope);
                if (slope >= slopeLimit) steep++;
            }
        }
        if (water > 0) blockers.Add("footprint_water");
        if (steep > 0) blockers.Add("footprint_steep_slope");
        return new { samples = (cols + 1) * (rows + 1), water_samples = water, steep_samples = steep,
            min_ground_height_m = minHeight, max_ground_height_m = maxHeight, maximum_slope_degrees = maxSlope,
            slope_limit_degrees = slopeLimit };
    }

    private static string[] CheckConstructionCollisions(BuildingsController buildings, Vector3[] points, Vector2[] footprint, float clearance, List<string> blockers)
    {
        var bounds = UnityEngine.GeometryUtility.CalculateBounds(points, Matrix4x4.identity);
        var nearby = Physics.OverlapBox(bounds.center, bounds.extents + new Vector3(clearance, 5f + clearance, clearance));
        var buildingIds = new HashSet<string>();
        // Construction temporarily disables collision on the building mesh, so check map footprints too.
        var search = Rect.MinMaxRect(bounds.min.x - clearance, bounds.min.z - clearance,
            bounds.max.x + clearance, bounds.max.z + clearance);
        foreach (var building in buildings.Buildings)
        {
            if (building == null || building.RawBuilding == null || building.IsDemolished || !search.Overlaps(building.AABB)) continue;
            if (building.TestCollisionXZ(footprint) || building.RawBuilding.GetOutlinePolygons().Any(polygon => polygon.DistanceToPolygon(footprint) < clearance))
                buildingIds.Add(building.Id);
        }
        var otherCollision = false;
        var obstacle = LayerMask.NameToLayer("Obstacle");
        var vehicle = LayerMask.NameToLayer("Vehicles");
        foreach (var collider in nearby)
        {
            if (collider.gameObject.layer == obstacle || collider.gameObject.layer == vehicle) continue;
            var markable = collider.GetComponent<IMarkableObject>();
            if (markable != null && markable is not Building && markable.TestCollisionXZ(footprint)) otherCollision = true;
        }
        if (buildingIds.Count > 0) blockers.Add("building_overlap_or_clearance");
        if (otherCollision) blockers.Add("structure_overlap");
        return buildingIds.OrderBy(id => id).ToArray();
    }

    private static float? ToGameHours(float gameplaySeconds) => TimeController.DayLengthInSeconds > 0
        ? gameplaySeconds * 24f / TimeController.DayLengthInSeconds : null;

    private static object[] ReadProductionRecipes(DiContainer container, PlaceableObjectDraft draft, int workers, int capacity)
    {
        var data = draft.ProductionsData;
        if (data?.productions == null) return Array.Empty<object>();
        var efficiency = container.Resolve<MoodController>().GetCurrentWorkersEfficiencyModifier();
        if (!SaveHandler.SaveData.PerfectWeather)
            efficiency *= data.GetTemperatureEfficiency(container.Resolve<WeatherController>().CurrentTemperature);
        return data.productions.Where(recipe => VisibleProductionRecipe(container, draft, recipe)).Select(recipe =>
        {
            var time = recipe.GetProductionTime();
            return new
            {
                recipe_id = recipe.Id,
                unlocked = SaveHandler.SaveData.ContentStateController.IsContentUnlocked(recipe.Id),
                inputs_per_cycle = recipe.GetCycleCost().ToDictionary(pair => pair.Key.ToString(), pair => pair.Value),
                outputs_per_cycle = recipe.GetCycleProfit().ToDictionary(pair => pair.Key.ToString(), pair => pair.Value),
                active_game_hours_per_cycle = workers > 0 && workers <= capacity && efficiency > 0.0001f
                    ? ToGameHours(time / (workers * efficiency)) : null,
                active_game_hours_at_capacity = capacity > 0 && efficiency > 0.0001f ? ToGameHours(time / (capacity * efficiency)) : null
            };
        }).Cast<object>().ToArray();
    }

    private object QueueConstruction(JObject args)
    {
        var plan = PlanConstruction(args);
        if (plan.Blockers.Count > 0)
            throw new BridgeException("construction_blocked", string.Join(", ", plan.Blockers.Distinct()));
        var container = WorldContainer();
        var id = Id(args, "request_id");
        if (plan.Existing != null)
        {
            container.Resolve<AdaptController>().StartFullAdapt(plan.Existing, plan.Draft);
            return new ConstructionOrder(id, Task.FromResult(plan.Existing));
        }
        if (pendingConstruction?.state == "placing")
            throw new BridgeException("construction_busy", "Wait for the previous placement receipt and preview this site again.");
        var builder = container.Instantiate<BuildingBuilder>().Start()
            .SetPolygon(new Polygon(plan.Footprint.ToList()))
            .AddTag(new OsmTag("building", "yes"))
            .AddTag(new OsmTag("height", plan.Height.ToString(CultureInfo.InvariantCulture)))
            .SetRoofType(CustomRoofTypes.Flat.AsRoofType())
            .SetFacadeType(plan.Facade)
            .SetStartingState(StructureStateType.Creating)
            .SetBuildingType(plan.Draft);
        var colors = Configs.GetConfig<CustomBuildingConfig>().GetDefaultColorsFor(plan.Facade);
        if (colors != null) builder.SetColor(colors.WallsColor).SetRoofColor(colors.RoofColor);
        pendingConstruction = new ConstructionOrder(id, RunConstruction(builder));
        return pendingConstruction;
    }

    private async Task<Building> RunConstruction(BuildingBuilder builder)
    {
        using var cancellation = new SceneCancellationTokenSource();
        try { return await builder.BuildAsync(cancellation.Token); }
        catch (Exception error)
        {
            Logger.LogError(error);
            throw;
        }
    }

    private object ReadConstructionOrder(JObject args)
    {
        if (!worldCommands.TryGetValue(Id(args, "request_id"), out var command) || command.Result is not ConstructionOrder order)
            throw new BridgeException("construction_order_not_found", "No construction order for this request_id in this settlement.");
        return order;
    }
}
