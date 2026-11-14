using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Controllers;
using Controllers.Time;
using Controllers.Weather;
using Data.Resorces;
using GameCustomization;
using Gameplay.Buildings;
using Gameplay.GameResources;
using Gameplay.Mood;
using Gameplay.ObjectOnMap;
using Gameplay.Production;
using Gameplay.Rebuilding;
using Gameplay.Rebuilding.Towers;
using Gameplay.Units.Equipment;
using Gameplay.Units.Player.Workers.WorkSystem;
using Gameplay.Units.Workers.WorkSystem;
using Newtonsoft.Json.Linq;
using UnityEngine;
using Zenject;

namespace IfzMcp;

/// <summary>
/// 单栋建筑完整信息 + 生产进度总览。
/// get_building_details 把一座建筑能读到的所有事实拼在一起：
/// 身份 / 状态 / 位置尺寸 / POI 图标 / 搜刮进度 / 库存 / 生产批次进度 /
/// 防御配置 / 医疗信息 / 关联工单 / 可选反射字段转储（含储量类字段）。
/// get_production_progress 只汇总所有生产设施的当前批次、进度、ETA 与缺料提示。
/// </summary>
public sealed partial class Plugin
{
    private static readonly BindingFlags ScalarFlags = BindingFlags.Public | BindingFlags.Instance;

    /// <summary>把简单值转成可序列化对象；复杂对象返回 null（调用方跳过）。</summary>
    private static object ScalarValue(object value)
    {
        switch (value)
        {
            case null:
                return null;
            case bool boolean:
                return boolean;
            case string text:
                return text.Length > 160 ? text.Substring(0, 160) : text;
            case Enum enumValue:
                return enumValue.ToString();
            case float number:
                return float.IsFinite(number) ? (object)(Mathf.Round(number * 1000f) / 1000f) : null;
            case double doubleNumber:
                return double.IsFinite(doubleNumber) ? (object)Math.Round(doubleNumber, 3) : null;
            case int integer:
                return integer;
            case long longInteger:
                return longInteger;
            case short shortInteger:
                return (int)shortInteger;
            case byte byteValue:
                return (int)byteValue;
            case decimal decimalValue:
                return (double)decimalValue;
            case Vector3 point:
                return new { x = point.x, y = point.y, z = point.z };
            case Vector2 flat:
                return new { x = flat.x, y = flat.y };
            case Color color:
                return new { r = color.r, g = color.g, b = color.b, a = color.a };
            case UnityEngine.Object unityObject:
                return new { name = unityObject.name, type = unityObject.GetType().Name };
        }

        var type = value.GetType();
        if (type.IsPrimitive || type.IsEnum) return value.ToString();

        // 资源箱 / 资源节点：带 Quantity + ResourceID 的轻量结构
        var quantityProperty = type.GetProperty("Quantity", ScalarFlags);
        var resourceProperty = type.GetProperty("ResourceID", ScalarFlags);
        if (quantityProperty != null && quantityProperty.PropertyType == typeof(float) && resourceProperty != null)
        {
            try
            {
                return new
                {
                    resource_id = resourceProperty.GetValue(value)?.ToString(),
                    quantity = quantityProperty.GetValue(value)
                };
            }
            catch
            {
                return null;
            }
        }

        return null;
    }

    /// <summary>
    /// 反射转储一个对象的标量属性/字段。只取 public 属性 + 声明类型自身的字段（含私有），
    /// 用来暴露“剩余储量”这类没有公开接口的数值，不递归对象图。
    /// </summary>
    private static Dictionary<string, object> ScalarDump(object instance, int maxEntries = 140)
    {
        var result = new Dictionary<string, object>();
        if (instance == null) return result;
        var type = instance.GetType();

        foreach (var property in type.GetProperties(ScalarFlags))
        {
            if (!property.CanRead || property.GetIndexParameters().Length > 0) continue;
            try
            {
                var converted = ScalarValue(property.GetValue(instance));
                if (converted != null) result[property.Name] = converted;
            }
            catch
            {
                // 单个属性读取失败不影响整体转储
            }
            if (result.Count >= maxEntries) return result;
        }

        foreach (var field in type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
        {
            if (field.DeclaringType != type) continue;
            try
            {
                var converted = ScalarValue(field.GetValue(instance));
                if (converted != null) result["field:" + field.Name] = converted;
            }
            catch
            {
                // 忽略无法读取的字段
            }
            if (result.Count >= maxEntries) break;
        }

        return result;
    }

    private static object ScalarDumpOrNull(object instance, bool enabled, int maxEntries = 140) =>
        enabled ? ScalarDump(instance, maxEntries) : null;

    private static object ResourceRows(ResourcesContainer container)
    {
        if (container == null) return Array.Empty<object>();
        return container.Resources
            .Where(item => item.Value > 0f)
            .Select(item => new
            {
                resource_id = item.Key.ToString(),
                quantity = item.Value,
                available = container.GetAvailableResourceQuantity(item.Key)
            })
            .ToArray();
    }

    /// <summary>找到这座建筑管理的工作（生产/建造/防御/维修等）。</summary>
    private static WorkBase[] WorksOfBuilding(WorkController controller, Structure structure, string buildingId)
    {
        var rows = new List<WorkBase>();
        foreach (var work in controller.Works)
        {
            if (work == null) continue;
            try
            {
                var related = work.GetRelatedStructure();
                if (related == null) continue;
                if (structure != null && ReferenceEquals(related, structure))
                {
                    rows.Add(work);
                    continue;
                }
                if (related.GetId() == buildingId) rows.Add(work);
            }
            catch
            {
                // 跳过已失效的工作
            }
        }
        return rows.ToArray();
    }

    private object ReadBuildingDetails(JObject args)
    {
        var container = WorldContainer();
        var building = FindBuilding(Text(args, "building_id", 64));
        var includeReflection = (bool?)args["include_reflection"] ?? true;
        var buildingId = building.Id.ToString();
        var controller = container.Resolve<WorkController>();

        Structure structure = null;
        try
        {
            structure = Facilities(container).FirstOrDefault(item => item != null && item.GetId() == buildingId);
        }
        catch
        {
            // 非玩家设施（废墟、未改造建筑）没有 Structure 记录，属正常情况
        }

        var works = WorksOfBuilding(controller, structure, buildingId)
            .Where(work => IsStaffableTask(work))
            .Select(work =>
            {
                var structureOfWork = work.GetRelatedStructure();
                return new
                {
                    task_id = WorkId(work),
                    task_type = work.GetType().Name,
                    employment = work.EmploymentType().ToString(),
                    structure_type = structureOfWork?.Draft?.Id,
                    assigned_workers = work.Workers.Count,
                    working_workers = work.WorkersWorking,
                    max_workers = work.MaxWorkers,
                    capacity = work.InitialMaxWorkers,
                    priority = work.Priority,
                    can_execute = work.CanExecute(),
                    paused = work.IsPaused,
                    suspended = work.IsSuspended
                };
            })
            .ToArray();

        var production = structure?.ProductionWork != null ? ReadFacilityProduction(container, structure, controller) : null;

        object defense = null;
        if (structure != null && HasDefenseSelector(structure))
            defense = ReadFacilityDefense(structure, controller, container.Resolve<StockroomsController>());

        object healthcare = null;
        if (structure != null && IsHealthcare(structure))
            healthcare = ReadFacilityHealthcare(structure, controller);

        var center = building.CenterPosition;
        var aabb = building.AABB;
        var flags = PoiFlagsOf(building);

        return new
        {
            session_id = sessionId,
            id = building.Id,
            osm_id = building.OsmId,
            type = building.Type,
            name = structure?.Draft?.GetNameBuilding(),
            facility = structure == null
                ? null
                : new
                {
                    structure_id = structure.GetId(),
                    structure_type = structure.GetType().Name,
                    draft_id = structure.Draft?.Id,
                    claimed_by_player = structure.IsClaimedByPlayer,
                    is_npc = structure.IsNpcStructure,
                    done = structure.IsDone
                },
            state = new
            {
                state_machine = building.StateMachine?.CurrentState?.StateType.ToString(),
                completed = building.IsCompleted,
                can_scavenge = building.CanScavenge(),
                scavenged = building.IsScavenged(),
                stockroom = building.IsStockroom(),
                had_resources_to_find = building.HadResourcesToFind
            },
            position = Position(center),
            bounds = new
            {
                min_x = aabb.xMin,
                min_z = aabb.yMin,
                max_x = aabb.xMax,
                max_z = aabb.yMax,
                width = aabb.width,
                length = aabb.height,
                center_x = aabb.center.x,
                center_z = aabb.center.y
            },
            poi_icons = flags,
            characters_inside = building.CharactersInside?.Count ?? 0,
            storage = ResourceRows(building.ResourcesContainer),
            scavenge = ScavengeSnapshot(building),
            production,
            defense,
            healthcare,
            works,
            reflection = includeReflection
                ? new
                {
                    building = ScalarDump(building),
                    structure = ScalarDumpOrNull(structure, structure != null),
                    scavenge_work = ScalarDumpOrNull(building.ScavengeWork, building.ScavengeWork != null),
                    production_work = ScalarDumpOrNull(structure?.ProductionWork, structure?.ProductionWork != null),
                    defense_work = ScalarDumpOrNull(structure?.DefenseWork, structure?.DefenseWork != null)
                }
                : null
        };
    }

    /// <summary>当前批次剩余游戏小时（按实际工人数和效率折算）。</summary>
    private static float? RemainingGameHours(DiContainer container, ProductionWork work)
    {
        var recipe = work?.ProductionData;
        if (recipe == null) return null;
        var workers = Math.Max(1, work.Workers.Count);
        var efficiency = container.Resolve<MoodController>().GetCurrentWorkersEfficiencyModifier();
        if (!SaveHandler.SaveData.PerfectWeather)
            efficiency *= work.Data.GetTemperatureEfficiency(container.Resolve<WeatherController>().CurrentTemperature);
        if (efficiency <= 0.0001f) return null;
        var totalHours = ToGameHours(recipe.GetProductionTime() / (workers * efficiency));
        var progress = Mathf.Clamp01(work.Progress);
        return (float?)Math.Round((totalHours ?? 0f) * (1f - progress), 3);
    }

    private object ReadProductionProgress(JObject args)
    {
        var container = WorldContainer();
        var stock = container.Resolve<StockroomsController>().Container;
        var controller = container.Resolve<WorkController>();
        var rows = new List<KeyValuePair<string, object>>();

        foreach (var structure in Facilities(container))
        {
            var work = structure.ProductionWork;
            if (work == null) continue;
            var recipe = work.ProductionData;
            var cost = recipe == null ? new Dictionary<ResourceID, int>() : recipe.GetCycleCost();
            var profit = recipe == null ? new Dictionary<ResourceID, int>() : recipe.GetCycleProfit();
            var missing = cost
                .Where(pair => pair.Value > 0 && stock.GetResourceQuantity(pair.Key) < pair.Value)
                .Select(pair => new
                {
                    resource_id = pair.Key.ToString(),
                    needed_per_cycle = pair.Value,
                    in_stockpile = stock.GetResourceQuantity(pair.Key)
                })
                .ToArray();
            var position = structure is Building building ? building.CenterPosition : structure.Position;
            var structureId = structure.GetId();
            rows.Add(new KeyValuePair<string, object>(structureId, new
            {
                structure_id = structureId,
                type_id = structure.Draft?.Id,
                name = structure.Draft?.GetNameBuilding(),
                position = Position(position),
                current_recipe_id = recipe?.Id,
                next_recipe_id = work.NextProductionData?.Id,
                cycle_progress = (float?)Math.Round(Mathf.Clamp01(work.Progress), 3),
                remaining_game_hours = RemainingGameHours(container, work),
                assigned_workers = work.Workers.Count,
                working_workers = work.WorkersWorking,
                max_workers = work.MaxWorkers,
                inputs_per_cycle = cost.Where(pair => pair.Value > 0).ToDictionary(pair => pair.Key.ToString(), pair => pair.Value),
                outputs_per_cycle = profit.Where(pair => pair.Value > 0).ToDictionary(pair => pair.Key.ToString(), pair => pair.Value),
                missing_inputs = missing,
                blocked_by_inputs = missing.Length > 0
            }));
        }

        return new
        {
            session_id = sessionId,
            count = rows.Count,
            facilities = rows.OrderBy(row => row.Key).Select(row => row.Value).ToArray()
        };
    }
}
