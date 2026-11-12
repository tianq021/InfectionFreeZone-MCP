using System;
using System.Linq;
using Controllers;
using Controllers.Time;
using Gameplay.Units;
using Gameplay.Units.Characters;
using Gameplay.Units.Enemy;
using Gameplay.Units.Equipment;
using Gameplay.Units.Interfaces;
using Gameplay.Units.Virtual;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

public sealed partial class Plugin
{
    private static readonly Lazy<Func<CharacterFightHandler, IAttackable, Weapon, bool>> CanPerformAttack =
        new(() => AccessTools.MethodDelegate<Func<CharacterFightHandler, IAttackable, Weapon, bool>>(
            AccessTools.Method(typeof(CharacterFightHandler), "CanPerformAttack")));
    private static readonly Lazy<Func<CharacterFightHandler, Vector3, Weapon, Weapon>> SelectAttackWeapon =
        new(() => AccessTools.MethodDelegate<Func<CharacterFightHandler, Vector3, Weapon, Weapon>>(
            AccessTools.Method(typeof(CharacterFightHandler), "SelectWeaponToUseByReach")));

    private static IGroup FindAttackTarget(Group squad, string id, bool virtualGroup)
    {
        if (virtualGroup)
        {
            var group = WorldContainer().Resolve<VirtualGroupsController>().Get(id);
            if (group == null || group.IsEmpty() || !group.IsVisible() || !squad.EnemiesProvider.IsEnemy(group))
                throw new BridgeException("invalid_attack_target", "Choose a visible hostile virtual group.");
            return group;
        }
        var target = FindNpcGroup(id);
        if (!target.IsVisible() || !target.CanBeAttacked() || !squad.EnemiesProvider.IsEnemy(target))
            throw new BridgeException("invalid_attack_target", "Choose a visible hostile group that can be attacked.");
        return target;
    }

    private object ReadAttackConditions(JObject args)
    {
        var squad = FindSquad(Text(args, "squad_id", 64));
        var groupId = Text(args, "group_id", 64);
        var virtualGroup = (bool?)args["virtual"] == true;
        var target = FindAttackTarget(squad, groupId, virtualGroup);
        var paused = TimeController.IsPaused;
        var mode = virtualGroup || squad.IsOnExpedition() ? "virtual" : "settlement";
        var targets = mode == "settlement"
            ? target.ICharacters.OfType<Character>().Where(character => character != null && !character.IsDead()).ToArray()
            : Array.Empty<Character>();
        var members = targets.Length == 0 ? Array.Empty<object>() : squad.Characters
            .Where(member => member != null && !member.IsDead() && member.FightModule != null)
            .Select(member => ReadMemberAttackConditions(member,
                targets.OrderBy(enemy => (enemy.Position - member.Position).sqrMagnitude).First(), paused)).ToArray();
        return new { session_id = sessionId, squad_id = squad.Id, group_id = groupId,
            mode, paused, target_member_count = target.ICharacters.Count, members };
    }

    private static object ReadMemberAttackConditions(Character member, Character target, bool paused)
    {
        var fight = member.FightModule;
        var equipped = member.ItemsContainer.WeaponHandler.CurrentWeapon;
        var weapon = SelectAttackWeapon.Value(fight, target.Position, null);
        var vehicle = member.VehicleModule?.CurrentVehicle;
        var mountedWeapon = vehicle != null && member.ItemsContainer.WeaponHandler.UseVehicleModificationWeapon;
        var ammo = mountedWeapon ? vehicle.AmmoContainer.AmmoCrate?.Quantity :
            member.ItemsContainer.AmmunitionHandler?.Ammunition?.Quantity;
        var range = fight.GetWeaponAttackReach(weapon);
        var inRange = fight.IsInWeaponAttackRange(weapon, target.Position);
        var clearPath = fight.CanShot(target);
        var onCooldown = fight.IsAttackOnCooldown();
        var allowed = CanPerformAttack.Value(fight, target, null) &&
            (!mountedWeapon || weapon != member.ItemsContainer.WeaponHandler.DefaultWeapon) &&
            !(member.VehicleModule?.InVehicle == true && member.VehicleModule.IsGunman && vehicle != null && vehicle.IsTurretRotating);
        var fromPosition = allowed && inRange && clearPath &&
            (!target.IsInsideEnterable() || target.Enterable == member.Enterable);
        var ready = fromPosition && fight.CanAttackThisFrame(target, raycast: false);
        return new { member_id = member.Id, name = member.Name, hp = member.Health.Hp,
            target_member_id = target.Id, distance = PlanarDistance(member.Position, target.Position),
            equipped_weapon_id = equipped?.ResourceType.ToString(), attack_weapon_id = weapon.ResourceType.ToString(),
            effective_range = range, in_range = inRange, line_of_sight = member.Weapon.UseProjectile ? (bool?)null : clearPath,
            clear_attack_path = clearPath, attack_allowed_from_state = allowed, on_cooldown = onCooldown,
            equipped_weapon_needs_ammo = equipped != null && equipped.UsesAmmunition() && !(ammo > 0),
            ammo, can_engage_from_position = fromPosition, can_attack_now = ready && !paused };
    }
}
