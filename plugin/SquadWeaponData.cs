using System.Collections.Generic;
using System.Linq;
using Data.Resorces;
using Gameplay.Units;
using Gameplay.Units.Characters;
using Gameplay.Units.Equipment;
using Newtonsoft.Json.Linq;
using ScriptableObjectScripts.ResorceData;

namespace IfzMcp;

public sealed partial class Plugin
{
    private object ReadSquadExperience(JObject args)
    {
        IEnumerable<Group> selected = args["squad_id"] == null
            ? squads.Squads.Where(squad => squad != null && !squad.IsDestroying)
            : new[] { FindSquad(Text(args, "squad_id", 64)) };
        var rows = selected.Select(squad => new
        {
            squad_id = squad.Id,
            name = squad.GroupName,
            members = squad.Characters
                .Where(member => member != null && member.CharacterInfo != null && !member.IsDead())
                .Select(ReadMemberExperience).ToArray()
        }).ToArray();
        return new { session_id = sessionId, count = rows.Length, squads = rows };
    }

    private static object ReadMemberExperience(Character member)
    {
        var handler = member.SkillsHandler;
        var weaponHandler = member.ItemsContainer?.WeaponHandler;
        var currentWeapon = weaponHandler?.Weapon != null ? member.Weapon : null;
        return new
        {
            member_id = member.Id,
            name = member.Name,
            experience_points = member.CharacterInfo.ExperiencePoints,
            experience_level = member.CharacterInfo.ExperienceLevel,
            skill_limit = handler?.MaxSkillCount,
            active_skills = handler?.GetAllActiveSkills().Select(skill => new
            {
                id = skill.Id.ToString(),
                name_key = skill.TranslateId,
                bonus = skill.BonusValue
            }).ToArray(),
            activities = member.KnowledgeGainer?.Activities.Select(activity => new
            {
                id = activity.ID.ToString(),
                experience = activity.CurrentExperience,
                max_experience = activity.MaxExperience,
                training_blocked = activity.MaxStatus
            }).ToArray(),
            current_weapon_id = currentWeapon == null ? null : currentWeapon.ResourceType.ToString(),
            effective_range = currentWeapon == null || currentWeapon.Stats == null
                ? (float?)null : member.FightModule?.GetWeaponAttackReach(currentWeapon)
        };
    }

    private object ReadWeaponDetails(JObject args)
    {
        var registry = ResourcesDataContainer.Instance;
        if (registry == null || registry.Resources == null)
            throw new BridgeException("weapon_data_not_ready", "Wait for the game to load the weapon catalog.");
        var selected = registry.Resources.OfType<Weapon>()
            .Concat(registry.AccessoryResourcesData.OfType<WeaponAccessoryResourceData>().Select(accessory => accessory.Weapon))
            .Where(weapon => weapon != null);
        if (args["weapon_id"] != null)
        {
            var id = Text(args, "weapon_id", 64);
            selected = selected.Where(weapon => weapon.ResourceType.ToString() == id);
        }
        var rows = selected.Select(ReadWeaponDetail).ToArray();
        if (args["weapon_id"] != null && rows.Length == 0)
            throw new BridgeException("weapon_not_found", "Use a weapon_id from the game weapon catalog.");
        return new { session_id = sessionId, count = rows.Length, weapons = rows };
    }

    private static object ReadWeaponDetail(Weapon weapon)
    {
        var stats = weapon.Stats;
        var id = weapon.ResourceType.ToString();
        var name = string.IsNullOrEmpty(weapon.GetTranslationKey()) ? id : weapon.GetName();
        return new
        {
            weapon_id = id,
            name = string.IsNullOrEmpty(name) ? id : name,
            melee = weapon.IsMelee,
            ammo_id = weapon.AmmoDraft?.ResourceType.ToString(),
            uses_ammunition = weapon.UsesAmmunition(),
            ammo_per_attack = weapon.ammoAmountUsed,
            magazine_capacity = weapon.magazineCapacity,
            can_use_inside_building = weapon.CanUseInsideEnterable,
            can_use_inside_vehicle = weapon.CanUseInsideVehicle,
            can_hit_fortified_target = weapon.canHitFortifiedTarget,
            can_attack_ground = weapon.CanAttackOnGround,
            uses_projectile = weapon.UseProjectileAmmo,
            explosive = weapon.IsExplosive,
            accessory_only = weapon.AccessoryUseOnly,
            market_available = weapon.MarketAvailable,
            move_speed_penalty = weapon.SpeedDecreaseValue,
            stats = stats == null ? null : new
            {
                base_range = stats.GetReach(expedition: false, reachModifier: 0f),
                base_expedition_range = stats.GetReach(expedition: true, reachModifier: 0f),
                close_range = stats.GetCloseRange(onExpedition: false),
                expedition_close_range = stats.GetCloseRange(onExpedition: true),
                attack_cooldown_game_seconds = stats.AttackCooldownGts,
                initiative = stats.Initiative,
                initiative_randomized = stats.UseRandomizedInitiative,
                damage_at_close_range = stats.MaxDmgCloseDistance,
                damage_at_max_range = stats.MaxDmgReachDistance,
                sharpshooter_damage_at_max_range = stats.SharpshooterMaxDmgReachDistance
            }
        };
    }
}
