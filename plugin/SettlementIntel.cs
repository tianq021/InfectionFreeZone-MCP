using System;
using System.Collections.Generic;
using System.Linq;
using Controllers;
using Controllers.CharacterLogic;
using Controllers.Time;
using Data.Resorces;
using Game;
using Gameplay.Buildings;
using Gameplay.GameResources;
using Gameplay.Laws;
using Gameplay.Rebuilding;
using Gameplay.Rebuilding.Towers;
using Gameplay.Research;
using Gameplay.Units.Characters;
using JutsuGamesConfig.Runtime;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

// Typed, read-only settlement APIs. No serialization, UI clicks or state setters.
public sealed partial class Plugin
{
    private static string IntelOptionalText(JObject args, string key, int length = 64) =>
        args[key] == null || args[key].Type == JTokenType.Null ? null : Text(args, key, length);

    private object IntelPage(JObject args, string category, IEnumerable<object> rows, object summary = null)
    {
        var (offset, limit) = PageRange(args);
        var result = JObject.FromObject(ReadPage(category, offset, limit, rows));
        result["source"] = "live-game";
        if (summary != null) result["summary"] = JObject.FromObject(summary);
        return result;
    }

    private static object ResearchIntel(Research research)
    {
        if (research == null) return null;
        var data = research.GetResearchData();
        var total = research.GetTotalResearchTime();
        var progress = total > 0f ? Mathf.Clamp01(research.CurrentResearchTime / total) : (float?)null;
        return new
        {
            research_id = research.GetID().ToString(),
            name = data.GetName(),
            group = research.Group.ToString(),
            state = research.ResearchState.ToString(),
            scientific_material_cost = research.GetCost(),
            already_paid = research.WasPayed,
            completed_count = research.CompletedCount,
            repeatable = data.IsLooped,
            progress,
            accumulated_work = research.CurrentResearchTime,
            required_work = total,
            work_unit = "native_research_work_units_not_elapsed_hours",
            child_research_ids = data.ChildrenResearches.Where(child => child != null)
                .Select(child => child.Research.ToString()).ToArray()
        };
    }

    private object ReadResearchStatus()
    {
        var controller = WorldContainer().Resolve<ResearchController>();
        return new
        {
            session_id = sessionId,
            source = "live-game",
            scientific_materials = controller.GatheredScientificMaterials,
            scientists = controller.ScientistsNumber,
            current_technology = ResearchIntel(controller.CurrentTechnology),
            current_law_research = ResearchIntel(controller.CurrentLaw),
            states = controller.Researches.Where(research => research != null)
                .GroupBy(research => research.ResearchState.ToString()).ToDictionary(group => group.Key, group => group.Count()),
            trees = controller.ResearchTypes.Where(type => type != null).Select(type => new
            {
                type_id = type.GetID().ToString(),
                group = type.GetGroup().ToString(),
                unlocked = type.IsUnlocked,
                root_research_id = type.GetRootResearchData()?.Research.ToString()
            }).ToArray()
        };
    }

    private object ReadResearchCatalog(JObject args)
    {
        var controller = WorldContainer().Resolve<ResearchController>();
        var group = IntelOptionalText(args, "group", 16);
        var state = IntelOptionalText(args, "state", 24);
        if (group != null && group != "technology" && group != "law")
            throw new BridgeException("invalid_research_group", "Choose technology or law.");
        if (state != null && !Enum.GetNames(typeof(ResearchStates)).Contains(state))
            throw new BridgeException("invalid_research_state", "Choose locked, unlocked, being_researched, completed or unavailable.");
        var all = controller.Researches.Where(research => research != null).ToArray();
        var matching = all.Where(research => (group == null || research.Group.ToString() == group) &&
            (state == null || research.ResearchState.ToString() == state)).OrderBy(research => research.GetID().ToString());
        return IntelPage(args, "research", matching.Select(research =>
        {
            var row = JObject.FromObject(ResearchIntel(research));
            row["parent_research_ids"] = JArray.FromObject(all.Where(parent =>
                parent.GetResearchData().ChildrenResearches.Any(child => child != null && child.Research == research.GetID()))
                .Select(parent => parent.GetID().ToString()));
            return (object)row;
        }), new { total_matching = matching.Count() });
    }

    private object ReadLaws()
    {
        var controller = WorldContainer().Resolve<LawsController>();
        return new
        {
            session_id = sessionId,
            source = "live-game",
            law_changed_today = controller.LawChangedToday,
            gathering_started = controller.GatheringStarted,
            gathering_finished = controller.GatheringFinished,
            gathering_elapsed_game_hours = controller.GatheringElapsedTime / TimeController.HourLengthInGts,
            consumption_multiplier = controller.GetConsumptionModifier(),
            work_start_hour_offset = controller.GetWorkStartingHourModifier(),
            work_end_hour_offset = controller.GetWorkEndingHourModifier(),
            birth_rate_multiplier = controller.GetBirtRateModifier(),
            groups = controller.LawsGroups.Where(group => group != null).Select(group => new
            {
                group_id = group.MyID.ToString(),
                name = group.GetGroupName(),
                unlocked = group.IsUnlocked,
                laws = group.Laws.Where(law => law?.Draft != null).Select(law => new
                {
                    law_id = law.Draft.Law.ToString(),
                    name = law.GetLawName(),
                    enabled = law.IsEnabled,
                    description = law.Draft.GetDescription(),
                    effects = law.Draft.LawEffects?.Where(effect => effect != null).Select(effect => new
                    {
                        positive = effect.IsPositive,
                        description = effect.GetDescription()
                    }).ToArray()
                }).ToArray()
            }).ToArray()
        };
    }

    private object ReadHousing(JObject args)
    {
        var container = WorldContainer();
        var assigner = container.Resolve<HouseAssigner>();
        var houses = container.Resolve<BuildingsController>().AdaptedBuildings.Cast<Structure>()
            .Concat(container.Resolve<ConvoyStructureController>().ConvoyStructures)
            .Where(house => house != null && house.Draft != null && house.Draft.HasLivingQuartersModule)
            .Distinct().OrderBy(house => house.GetId()).ToArray();
        var capacity = container.Resolve<BuildingsController>().GetLivingQuartersCapacity() +
            container.Resolve<ConvoyStructureController>().GetLivingQuartersCapacity();
        return IntelPage(args, "housing", houses.Select(house => new
        {
            structure_id = house.GetId(),
            type_id = house.Draft?.Id,
            position = Position(house is Building building ? building.CenterPosition : house.Position),
            capacity = house.GetCitizensCapacity(),
            assigned_residents = house.LivingCitizens.Count,
            free_places = Math.Max(0, house.GetCitizensCapacity() - house.LivingCitizens.Count),
            preferred_for_assignment = assigner.Houses.Contains(house),
            completed = house.IsDone
        }), new
        {
            total_houses = houses.Length,
            population = CitizensController.CitizensCount,
            capacity,
            homeless_due_to_capacity = assigner.GetHomelessCount(),
            note = "Homeless count is the game's capacity shortfall; assigned residents may still be moving or awaiting reassignment."
        });
    }

    private object ReadResourceDefinitions(JObject args)
    {
        WorldContainer();
        var id = IntelOptionalText(args, "resource_id");
        var rows = ResourcesDataContainer.Instance.Resources.Where(resource => resource != null &&
            (id == null || resource.ResourceType.ToString() == id)).OrderBy(resource => resource.ResourceType.ToString()).ToArray();
        if (id != null && rows.Length == 0)
            throw new BridgeException("resource_not_found", "Read get_resource_definitions without resource_id for valid identifiers.");
        return IntelPage(args, "resource_definitions", rows.Select(resource => new
        {
            resource_id = resource.ResourceType.ToString(),
            name = resource.GetName(),
            definition_type = resource.GetType().Name,
            true_quantity_per_crate = resource.TrueQuantity,
            can_be_sold = resource.CanBeSold,
            market_available = resource.MarketAvailable,
            base_trade_value = resource.BaseTradeValue,
            can_discard = resource.CanBeDiscard,
            dismount_output = resource.DismountOutput?.Where(output => output != null).Select(output => new
            {
                resource_id = output.resourceType.ToString(),
                quantity = output.value
            }).ToArray()
        }), new { total_matching = rows.Length });
    }

    private static object StorageIntel(ResourcesContainer container) => container == null ? null : new
    {
        capacity_crates = container.Capacity,
        occupied_or_locked_slots = container.GetCratesCount(),
        free_crates = container.SpaceLeftInCrates,
        locked_crates = container.GetLockedCratesCount(),
        locked_resources = container.LockedResources.ToDictionary(row => row.Key.ToString(), row => row.Value),
        slot_semantics = "Occupied slots include empty slots locked for a resource. free_crates = capacity_crates - occupied_or_locked_slots; it is not physical inventory quantity."
    };

    private object ReadStorageCapacity(JObject args)
    {
        var controller = WorldContainer().Resolve<StockroomsController>();
        var rooms = SharedStockrooms().OrderBy(room => StockroomId(room)).ToArray();
        return IntelPage(args, "storage_capacity", rooms.Select(room => new
        {
            structure_id = StockroomId(room),
            type_id = room.Draft?.Id,
            position = Position(room is Building building ? building.CenterPosition : room.Position),
            headquarters = room == HqController.MainHeadquarter,
            // The game sums this local capacity, but stores the inventory in one shared container.
#pragma warning disable CS0618
            capacity_contribution_crates = room.StructureResourceContainer.Capacity
#pragma warning restore CS0618
        }), new
        {
            total_shared_stockrooms = rooms.Length,
            physical = StorageIntel(controller.Container),
            virtual_resources = StorageIntel(controller.VirtualResourcesContainer),
            virtual_capacity_note = "The virtual container has no physical warehouse capacity. Its native capacity is zero and free_crates may be negative after forced additions; this does not indicate a need for more storage buildings.",
            inventory_model = "Shared stockrooms contribute capacity to one global inventory; there is no per-building stock split."
        });
    }

    private Character[] IntelPopulation() => WorldContainer().Resolve<CitizensController>().Citizens
        .Concat(squads.Squads.Where(squad => squad != null && !squad.IsDestroying)
            .SelectMany(squad => squad.Characters))
        .Where(character => character != null && character.CharacterInfo != null && !character.IsDead())
        .GroupBy(character => character.Id).Select(group => group.First()).OrderBy(character => character.Id).ToArray();

    private object ReadPopulationHealth(JObject args)
    {
        var people = IntelPopulation();
        return IntelPage(args, "population_health", people.Select(character => new
        {
            character_id = character.Id,
            name = character.Name,
            child = character.IsChild,
            soldier = character.IsSoldier,
            hp = character.Health?.Hp,
            max_hp = character.Health?.MaxHp,
            sick = character.IsSick,
            being_treated = character.IsBeingTreated,
            starving = character.FoodConsumer?.IsStarving,
            vaccinated = character.FoodConsumer?.IsVaccinated,
            fatigue = character.WorkModule?.Fatigue,
            sickness = character.Sickness == null ? null : new
            {
                critical = character.Sickness.IsCritical,
                medicine_shortage = character.Sickness.NotEnoughMedicines,
                recovery_progress_days = character.Sickness.currentDays,
                recovery_required_days = character.Sickness.daysToCure
            }
        }), new
        {
            population_observed = people.Length,
            sick = people.Count(character => character.IsSick),
            critical = people.Count(character => character.Sickness?.IsCritical == true),
            being_treated = people.Count(character => character.IsBeingTreated),
            wounded = people.Count(character => character.Health != null && character.Health.Hp < character.Health.MaxHp),
            starving = people.Count(character => character.FoodConsumer?.IsStarving == true),
            missing_food_state = people.Count(character => character.FoodConsumer == null),
            missing_health_state = people.Count(character => character.Health == null)
        });
    }

    private object ReadFoodStatus()
    {
        var container = WorldContainer();
        var people = IntelPopulation();
        var config = Configs.GetConfig<FoodConsumingConfig>();
        var consumption = config.GetFoodConsumingData();
        var stock = container.Resolve<StockroomsController>().Container;
        var multiplier = container.Resolve<LawsController>().GetConsumptionModifier();
        var children = people.Count(person => person.IsChild);
        var soldiers = people.Count(person => !person.IsChild && person.IsSoldier);
        var otherAdults = people.Length - children - soldiers;
        var estimate = (children * consumption.ChildConsumePerDay + soldiers * consumption.SoldierConsumePerDay +
            otherAdults * consumption.WorkerConsumePerDay) * multiplier;
        var edible = stock.GetAvailableResourceQuantity(ResourceID.res_food_rations) + stock.GetAvailableResourceQuantity(ResourceID.res_cans);
        var foodIds = new[] { ResourceID.res_food_rations, ResourceID.res_cans, ResourceID.res_meat, ResourceID.res_vegetables, ResourceID.res_grain };
        return new
        {
            session_id = sessionId,
            source = "live-game",
            consumption_hour = Configs.GetConfig<GameConfig>().hourOfConsuming,
            hunger_disabled = SaveHandler.SaveData.NoHunger,
            per_person_daily_crates = new
            {
                child = consumption.ChildConsumePerDay,
                soldier = consumption.SoldierConsumePerDay,
                other_adult = consumption.WorkerConsumePerDay,
                law_multiplier = multiplier
            },
            observed_population = new { children, soldiers, other_adults = otherAdults },
            stocks = foodIds.Select(id => new
            {
                resource_id = id.ToString(),
                quantity = stock.GetResourceQuantity(id),
                available = stock.GetAvailableResourceQuantity(id),
                directly_consumable = id == ResourceID.res_food_rations || id == ResourceID.res_cans
            }).ToArray(),
            expiration = new
            {
                bucket_unit = "day_transitions_until_expiration; bucket 1 expires at the next day transition",
                food_rations_shelf_life_days = config.FoodShelfLife,
                meat_shelf_life_days = config.MeatShelfLife,
                food_rations = stock.GetFoodRationsExpirations().Select((quantity, index) => new { day_transitions = index + 1, quantity }).ToArray(),
                meat = stock.GetMeatRationsExpirations().Select((quantity, index) => new { day_transitions = index + 1, quantity }).ToArray()
            },
            estimate = new
            {
                daily_consumption_crates = SaveHandler.SaveData.NoHunger ? 0f : estimate,
                shared_edible_stock_days = !SaveHandler.SaveData.NoHunger && estimate > 0f ? edible / estimate : (float?)null,
                assumptions = "Current observed living population and law multiplier; only rations and cans are directly edible. Ignores production, spoilage, per-person serving thresholds, squad/vehicle cargo and access to shared stock. This is a supply estimate, not an observed consumption rate."
            }
        };
    }

    private static float FlowCount(IReadOnlyDictionary<ResourceID, float> values, ResourceID id) =>
        values.TryGetValue(id, out var amount) ? amount : 0f;

    private static object FlowPeriod(MainResourcesContainer container, ResourceID id, bool previous)
    {
        var produced = FlowCount(previous ? container.ResourcesProducedPreviousDay : container.ResourcesProducedInLast24H, id);
        var scavenged = FlowCount(previous ? container.ResourcesScavengedPreviousDay : container.ResourcesScavengedInLast24H, id);
        var used = FlowCount(previous ? container.ResourcesUsedPreviousDay : container.ResourcesUsedInLast24H, id);
        return new { produced, scavenged, used, tracked_net = produced + scavenged - used };
    }

    private object ReadResourceFlows(JObject args)
    {
        var controller = WorldContainer().Resolve<StockroomsController>();
        var id = IntelOptionalText(args, "resource_id");
        if (id != null && !Enum.GetNames(typeof(ResourceID)).Contains(id))
            throw new BridgeException("resource_not_found", "Choose a resource ID from get_resource_definitions.");
        var containers = new[] { (name: "physical", value: controller.Container), (name: "virtual", value: controller.VirtualResourcesContainer) };
        var rows = containers.SelectMany(storage => storage.value.Resources.Keys
            .Concat(storage.value.ResourcesProducedInLast24H.Keys).Concat(storage.value.ResourcesScavengedInLast24H.Keys)
            .Concat(storage.value.ResourcesUsedInLast24H.Keys).Concat(storage.value.ResourcesProducedPreviousDay.Keys)
            .Concat(storage.value.ResourcesScavengedPreviousDay.Keys).Concat(storage.value.ResourcesUsedPreviousDay.Keys)
            .Distinct().Where(resource => resource != ResourceID.None && (id == null || resource.ToString() == id))
            .Where(resource => id != null || storage.value.GetResourceQuantity(resource) != 0f ||
                FlowCount(storage.value.ResourcesProducedInLast24H, resource) != 0f || FlowCount(storage.value.ResourcesScavengedInLast24H, resource) != 0f ||
                FlowCount(storage.value.ResourcesUsedInLast24H, resource) != 0f || FlowCount(storage.value.ResourcesProducedPreviousDay, resource) != 0f ||
                FlowCount(storage.value.ResourcesScavengedPreviousDay, resource) != 0f || FlowCount(storage.value.ResourcesUsedPreviousDay, resource) != 0f)
            .OrderBy(resource => resource.ToString()).Select(resource => (object)new
            {
                storage = storage.name,
                resource_id = resource.ToString(),
                quantity = storage.value.GetResourceQuantity(resource),
                since_day_transition = FlowPeriod(storage.value, resource, false),
                previous_day = FlowPeriod(storage.value, resource, true)
            }));
        return IntelPage(args, "resource_flows", rows, new
        {
            day = TimeController.Day,
            hour = TimeController.Hour,
            period = "Native counters reset on the game's day transition; these are not rolling 24-hour rates.",
            caveat = "Native used counters record removal requests, including failed requests; they are not guaranteed actual consumption. Transfers, spoilage and untracked changes can also make tracked_net differ from inventory delta."
        });
    }
}
