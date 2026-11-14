using System;
using System.Collections.Generic;
using System.Linq;
using Controllers;
using Convoy.Locations;
using Gameplay.Buildings;
using Gameplay.Immigrants;
using Gameplay.ObjectOnMap;
using Gameplay.Rebuilding;
using Gameplay.Units;
using Gameplay.Units.Enemy;
using Newtonsoft.Json.Linq;

namespace IfzMcp;

// Native NPC zone inspection only. Never invokes reveal, spawn, takeover or dialogue actions.
public sealed partial class Plugin
{
    private static string GroupAffiliationToPlayer(Group group)
    {
        if (group?.AffiliationProvider == null) return null;
        // Get(Fraction.Player) directly indexes a dictionary and can throw for an absent relation.
        // Serialize() copies that dictionary to an in-memory array; it does not write a save.
        foreach (var entry in group.AffiliationProvider.Serialize())
            if (entry.Fraction == Fraction.Player) return entry.Affiliation.ToString();
        return null;
    }

    private static bool? GroupCanBeAttacked(Group group) =>
        group == null || group.StateMachine == null ? null : group.CanBeAttacked();

    private static bool IncludeNpcHidden(JObject args) => (bool?)args["include_hidden"] ?? false;

    private static Group[] NpcCurrentGroups() => WorldContainer().Resolve<GroupsController>().Groups
        .Where(group => group != null && !group.IsDestroying)
        .GroupBy(group => group.Id).Select(group => group.First()).OrderBy(group => group.Id).ToArray();

    private static Group[] NpcTaggedGroups() => NpcCurrentGroups()
        .Where(group => group.Fraction != Fraction.Player && group.HasId(NpcZoneController.NpcZoneGroupId)).ToArray();

    private sealed class NpcStructureRecord
    {
        public string Id;
        public Type Type;
        public Structure Structure;
    }

    private static NpcStructureRecord[] NpcStructureRecords(NpcZoneController controller)
    {
        var records = controller.NpcZoneStructureIds;
        if (records == null || records.Count == 0) return Array.Empty<NpcStructureRecord>();
        var objects = WorldContainer().Resolve<PlaceableObjectsController>();
        // Enumerate already loaded objects. Unlike GetBuildingById this also handles stale records
        // without logging errors, and never loads a missing object or changes its visibility.
        var loaded = objects.BuildingsController.Buildings.Cast<Structure>()
            .Concat(objects.FarmlandsController.Farmlands).Concat(objects.MinefieldController.Minefields)
            .Concat(objects.TowersController.Towers).Concat(objects.WallsController.Walls)
            .Concat(objects.GatesController.Gates).Concat(objects.FishermanStructureController.Fishermans)
            .Concat(objects.ClayPitStructureController.Structures).Concat(objects.ConvoyStructureController.ConvoyStructures)
            .Where(structure => structure != null)
            .GroupBy(structure => (structure.GetType(), structure.GetId()))
            .ToDictionary(group => group.Key, group => group.First());
        return records.GroupBy(record => (record.Type, record.Id)).Select(group => group.First())
            .Select(record => new NpcStructureRecord
            {
                Id = record.Id,
                Type = record.Type,
                Structure = record.Type != null && record.Id != null && loaded.TryGetValue((record.Type, record.Id), out var structure)
                    ? structure : null
            }).OrderBy(record => record.Type?.FullName).ThenBy(record => record.Id).ToArray();
    }

    private static object NpcStructureRow(NpcStructureRecord record)
    {
        var structure = record.Structure;
        return new
        {
            structure_id = record.Id,
            structure_type = record.Type?.Name,
            resolved = structure != null,
            type_id = structure?.Draft?.Id,
            name = structure?.Draft?.GetNameBuilding(),
            position = structure == null ? null : Position(structure is Building building ? building.CenterPosition : structure.Position),
            state = structure?.StateMachine?.CurrentState?.StateType.ToString(),
            marked_zone_type = structure?.MarkedAsPartOfZoneType.ToString(),
            is_npc = structure?.StateMachine == null ? (bool?)null : structure.IsNpcStructure,
            claimed_by_player = structure == null ? (bool?)null : structure.IsClaimedByPlayer,
            completed = structure == null ? (bool?)null : structure.IsDone,
            ruined = structure == null ? (bool?)null : structure.IsRuined,
            hp = structure?.Health?.Hp,
            max_hp = structure?.Health?.MaxHp
        };
    }

    private static object NpcGroupRow(Group group)
    {
        var relation = GroupAffiliationToPlayer(group);
        return new
        {
            group_id = group.Id,
            name = group.GroupName,
            group_type = group.Type,
            faction = group.Fraction.ToString(),
            affiliation_to_player = relation,
            relation_known = relation != null,
            relation_hostile_to_player = relation == null ? (bool?)null : relation == nameof(Affiliation.Hostile),
            npc_zone_member = group.HasId(NpcZoneController.NpcZoneGroupId),
            immigrants_state = group.ImmigrantsState.ToString(),
            waiting_for_transmission = group.ImmigrantsState == ImmigrantsState.WaitingForTransmission,
            visible = group.IsVisible(),
            can_be_attacked = GroupCanBeAttacked(group),
            position = Position(group.Position),
            member_count = group.Characters.Count,
            living_members = group.Characters.Count(character => character != null && character.CharacterInfo != null && !character.IsDead()),
            weapon_id = group.Weapon?.ResourceType.ToString(),
            active_order = group.OrdersHandlers?.OrdersQueue.CurrentOrder?.GetType().Name
        };
    }

    private object ReadNpcZone(JObject args)
    {
        var controller = WorldContainer().Resolve<NpcZoneController>();
        var records = NpcStructureRecords(controller);
        var groups = NpcTaggedGroups();
        var includeHidden = IncludeNpcHidden(args);
        var detailsKnown = controller.NpcZoneRevealed || controller.NpcZoneTakenOver || includeHidden;
        var describedGroups = groups.Where(group => includeHidden || group.IsVisible()).ToArray();
        var location = NpcZoneController.SelectedLocationType;
        var primary = records.FirstOrDefault(record => record.Structure?.Draft?.IsHq == true);
        return new
        {
            session_id = sessionId,
            source = "live-game",
            location_type = location.ToString(),
            revealed = controller.NpcZoneRevealed,
            taken_over = controller.NpcZoneTakenOver,
            has_registered_structures = records.Length > 0,
            presence = records.Length > 0 || groups.Length > 0 ? "registered" :
                controller.NpcZoneTakenOver ? "taken_over_without_remaining_records" :
                location == LocationType.NormalPlace || location == LocationType.QuietPlace ? "none_registered" : "not_generated_or_no_records",
            registered_structure_count = records.Length,
            resolved_structure_count = records.Count(record => record.Structure != null),
            missing_structure_count = records.Count(record => record.Structure == null),
            current_npc_group_count = groups.Length,
            visible_npc_group_count = groups.Count(group => group.IsVisible()),
            summarized_group_count = describedGroups.Length,
            summarized_living_members = describedGroups.Sum(group => group.Characters.Count(character =>
                character != null && character.CharacterInfo != null && !character.IsDead())),
            summarized_groups_by_relation = describedGroups.GroupBy(group => GroupAffiliationToPlayer(group) ?? "unknown")
                .ToDictionary(group => group.Key, group => group.Count()),
            summarized_waiting_for_transmission = describedGroups.Count(group => group.ImmigrantsState == ImmigrantsState.WaitingForTransmission),
            include_hidden = includeHidden,
            structure_details_available = detailsKnown,
            headquarters = detailsKnown && primary != null ? NpcStructureRow(primary) : null,
            note = "This is the current map's NPC zone registry, not every convoy destination. Group summaries include visible groups unless include_hidden=true; building details require zone discovery or takeover. A tagged group waiting for transmission is not a guarantee of a currently selectable radio reply."
        };
    }

    private object ReadNpcZoneGroups(JObject args)
    {
        var controller = WorldContainer().Resolve<NpcZoneController>();
        var includeHidden = IncludeNpcHidden(args);
        var groups = NpcTaggedGroups();
        var visible = groups.Where(group => includeHidden || group.IsVisible()).ToArray();
        return IntelPage(args, "npc_zone_groups", visible.Select(NpcGroupRow), new
        {
            location_type = NpcZoneController.SelectedLocationType.ToString(),
            revealed = controller.NpcZoneRevealed,
            taken_over = controller.NpcZoneTakenOver,
            total_current_tagged_groups = groups.Length,
            total_matching = visible.Length,
            excluded_hidden_groups = groups.Length - visible.Length,
            include_hidden = includeHidden,
            visibility_scope = "current_group_visibility",
            note = "Only existing non-player groups with the native NpcZoneGroup tag are included. Ordinary immigrants and virtual expedition groups are excluded. Relationships are directional toward the player; attackability additionally depends on native visibility and state."
        });
    }

    private object ReadNpcZoneStructures(JObject args)
    {
        var controller = WorldContainer().Resolve<NpcZoneController>();
        var records = NpcStructureRecords(controller);
        var includeHidden = IncludeNpcHidden(args);
        var available = controller.NpcZoneRevealed || controller.NpcZoneTakenOver || includeHidden;
        var matching = available ? records : Array.Empty<NpcStructureRecord>();
        return IntelPage(args, "npc_zone_structures", matching.Select(NpcStructureRow), new
        {
            location_type = NpcZoneController.SelectedLocationType.ToString(),
            revealed = controller.NpcZoneRevealed,
            taken_over = controller.NpcZoneTakenOver,
            registered_structure_count = records.Length,
            resolved_structure_count = records.Count(record => record.Structure != null),
            missing_structure_count = records.Count(record => record.Structure == null),
            total_matching = matching.Length,
            include_hidden = includeHidden,
            details_available = available,
            visibility_scope = "zone_discovered_or_taken_over_not_current_line_of_sight",
            note = "The native registry may retain ruins or structures now owned by the player. Missing references are returned with resolved=false; a zero-item response can mean the zone is still undiscovered. This query does not reveal or adapt structures."
        });
    }

    private object ReadGroupRelations(JObject args)
    {
        var includeHidden = IncludeNpcHidden(args);
        var requestedId = IntelOptionalText(args, "group_id");
        var groups = NpcCurrentGroups();
        var selected = groups.Where(group => requestedId == null || group.Id == requestedId).ToArray();
        var matching = selected.Where(group => includeHidden || group.IsVisible()).ToArray();
        return IntelPage(args, "group_relations", matching.Select(NpcGroupRow), new
        {
            requested_group_id = requestedId,
            total_selected = selected.Length,
            total_matching = matching.Length,
            excluded_hidden_groups = selected.Length - matching.Length,
            include_hidden = includeHidden,
            visibility_scope = "current_group_visibility",
            unknown_relations = matching.Count(group => GroupAffiliationToPlayer(group) == null),
            relations = Enum.GetNames(typeof(Affiliation)),
            note = "Reads real groups only. faction is an identity, affiliation_to_player is that group's native directional relation, and can_be_attacked is a separate state/visibility test. Unknown relations are null, never inferred from faction or hidden status."
        });
    }
}
