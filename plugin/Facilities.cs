using System.Collections.Generic;
using System.Linq;
using Controllers;
using GameCustomization;
using Gameplay.Buildings;
using Gameplay.ObjectOnMap;
using Gameplay.Rebuilding;
using Gameplay.Rebuilding.Towers;
using Gameplay.Units.Equipment;
using Gameplay.Units.Player.Workers.WorkSystem;
using Gameplay.Units.Workers.WorkSystem;
using Newtonsoft.Json.Linq;
using Zenject;

namespace IfzMcp;

public sealed partial class Plugin
{
    private static IEnumerable<Structure> Facilities(DiContainer container)
    {
        var objects = container.Resolve<PlaceableObjectsController>();
        return objects.BuildingsController.AdaptedBuildings.Cast<Structure>()
            .Concat(objects.GatesController.Gates).Concat(objects.TowersController.Towers)
            .Concat(objects.FarmlandsController.Farmlands).Concat(objects.FishermanStructureController.Fishermans)
            .Concat(objects.ClayPitStructureController.Structures).Concat(objects.ConvoyStructureController.ConvoyStructures)
            .Where(structure => structure != null && structure.IsDone && !structure.IsNpcStructure && structure.Draft != null &&
                (structure is Building || structure.IsClaimedByPlayer || structure == HqController.MainHeadquarter));
    }

    private static Structure FindFacility(DiContainer container, JObject args)
    {
        var id = Text(args, "structure_id", 64);
        return Facilities(container).FirstOrDefault(structure => structure.GetId() == id) ??
            throw new BridgeException("facility_unavailable", "Read get_facilities for a completed player facility ID.");
    }

    private static bool IsHealthcare(Structure structure) => structure.TreatmentSubWork != null || structure.HealingSubWork != null;

    private static bool HasDefenseSelector(Structure structure) =>
        structure is IDefensible { DefenceModule: not null } && structure.Draft.DefenceData?.DefaultWeapon != null;

    private static IEnumerable<Weapon> FacilityWeapons(Structure structure) =>
        (structure.Draft.DefenceData.WeaponsUsable ?? System.Array.Empty<Weapon>())
            .Prepend(structure.Draft.DefenceData.DefaultWeapon).Where(weapon => weapon != null).Distinct();

    private string FacilityWorkId(WorkController controller, WorkBase work) =>
        work != null && IsStaffableTask(work) && controller.Works.Contains(work) ? WorkId(work) : null;

    private static bool VisibleProductionRecipe(DiContainer container, PlaceableObjectDraft draft, ProductionData recipe) =>
        draft.Id != "bld_hospital" || recipe.Id != "prod_vaccine" || container.Resolve<GameCustomize>().Sickness;

    private object ReadFacilities(JObject args)
    {
        var container = WorldContainer();
        var category = Text(args, "category", 16);
        var (offset, limit) = PageRange(args);
        var matching = Facilities(container).Where(structure => category switch
        {
            "production" => structure.ProductionWork != null,
            "defense" => HasDefenseSelector(structure),
            "healthcare" => IsHealthcare(structure),
            _ => throw new BridgeException("invalid_facility_category", "Choose production, defense or healthcare.")
        });
        if (args["structure_id"] != null)
        {
            var id = Text(args, "structure_id", 64);
            matching = matching.Where(structure => structure.GetId() == id);
        }
        var controller = container.Resolve<WorkController>();
        var stock = container.Resolve<StockroomsController>();
        return ReadPage(category, offset, limit, matching.Select(structure =>
        {
            var position = structure is Building building ? building.CenterPosition : structure.Position;
            return new
            {
                structure_id = structure.GetId(),
                structure_type = structure.GetType().Name,
                type_id = structure.Draft.Id,
                name = structure.Draft.GetNameBuilding(),
                position = Position(position),
                production = category != "defense" && structure.ProductionWork != null
                    ? ReadFacilityProduction(container, structure, controller) : null,
                defense = category == "defense" ? ReadFacilityDefense(structure, controller, stock) : null,
                healthcare = category == "healthcare" ? ReadFacilityHealthcare(structure, controller) : null
            };
        }));
    }

    private object ReadFacilityProduction(DiContainer container, Structure structure, WorkController controller)
    {
        var work = structure.ProductionWork;
        return new
        {
            task_id = FacilityWorkId(controller, work),
            current_recipe_id = work.ProductionData?.Id,
            next_recipe_id = work.NextProductionData?.Id,
            cycle_progress = work.Progress,
            assigned_workers = work.Workers.Count,
            max_workers = work.MaxWorkers,
            recipes = ReadProductionRecipes(container, structure.Draft, work.Workers.Count, work.InitialMaxWorkers)
        };
    }

    private object ReadFacilityDefense(Structure structure, WorkController controller, StockroomsController stock)
    {
        var defensible = (IDefensible)structure;
        var module = defensible.DefenceModule;
        var work = structure.DefenseWork;
        return new
        {
            task_id = FacilityWorkId(controller, work),
            selected_weapon_id = module.SelectedWeapon?.ResourceType.ToString(),
            assigned_guards = work?.Workers.Count ?? 0,
            max_guards = work?.MaxWorkers ?? 0,
            options = FacilityWeapons(structure).Select(weapon => new
            {
                weapon_id = weapon.ResourceType.ToString(),
                is_default = weapon == module.DefaultWeapon,
                at_structure = defensible.ResContainer.GetResourceQuantity(weapon.ResourceType),
                in_stockpile = stock.GetResourceQuantity(weapon.ResourceType),
                ammo_id = weapon.AmmoDraft?.ResourceType.ToString(),
                ammo_in_stockpile = weapon.AmmoDraft == null ? (float?)null : stock.GetResourceQuantity(weapon.AmmoDraft.ResourceType)
            }).ToArray()
        };
    }

    private object ReadFacilityHealthcare(Structure structure, WorkController controller)
    {
        var treatment = structure.TreatmentSubWork;
        var healing = structure.HealingSubWork;
        var work = structure.ProductionWork ?? structure.CurrentWork;
        return new
        {
            task_id = FacilityWorkId(controller, work),
            assigned_doctors = treatment?.CurrentPhysicians ?? work?.Workers.Count ?? 0,
            treatment_beds = treatment?.Beds.Count,
            occupied_beds = treatment?.OcuppiedBeds.Count,
            available_staffed_beds = treatment?.GetAvailableBedsCount(),
            soldier_healing_per_bed_per_game_hour = treatment == null ? (float?)null : structure.Draft.BedHealingSpeed,
            civilian_healing_per_game_hour = healing?.HealingSpeed
        };
    }

    private object SetFacilityProduction(JObject args)
    {
        var container = WorldContainer();
        var structure = FindFacility(container, args);
        var work = structure.ProductionWork ??
            throw new BridgeException("production_unavailable", "This facility does not have active production.");
        var recipe = work.Data.GetProductionData(Text(args, "recipe_id", 96));
        if (recipe == null || !VisibleProductionRecipe(container, structure.Draft, recipe) ||
            !SaveHandler.SaveData.ContentStateController.IsContentUnlocked(recipe.Id))
            throw new BridgeException("recipe_unavailable", "Use an unlocked recipe from this facility's production list.");
        if ((string)args["expected_current_recipe_id"] != work.ProductionData?.Id ||
            (string)args["expected_next_recipe_id"] != work.NextProductionData?.Id)
            throw new BridgeException("production_changed", "Read the facility again before selecting a product.");
        if (recipe != work.NextProductionData)
        {
            if (recipe != work.ProductionData) work.ChangeProduction(recipe);
            else if (work.NextProductionData != null) work.CancelNextProduction();
        }
        return new { structure_id = structure.GetId(), current_recipe_id = work.ProductionData?.Id,
            next_recipe_id = work.NextProductionData?.Id, cycle_progress = work.Progress };
    }

    private object SetFacilityDefenseWeapon(JObject args)
    {
        var container = WorldContainer();
        var structure = FindFacility(container, args);
        if (!HasDefenseSelector(structure))
            throw new BridgeException("defense_unavailable", "This facility has no native defense weapon selector.");
        var module = ((IDefensible)structure).DefenceModule;
        var weaponId = Text(args, "weapon_id", 96);
        var weapon = FacilityWeapons(structure).FirstOrDefault(option => option.ResourceType.ToString() == weaponId) ??
            throw new BridgeException("weapon_not_supported", "Use a weapon from this facility's own options list.");
        if ((string)args["expected_weapon_id"] != module.SelectedWeapon?.ResourceType.ToString())
            throw new BridgeException("weapon_changed", "Read the facility again before selecting a weapon.");
        if (module.SelectedWeapon != weapon) module.SetupWeapon(weapon);
        return new { structure_id = structure.GetId(), selected_weapon_id = module.SelectedWeapon?.ResourceType.ToString() };
    }
}
