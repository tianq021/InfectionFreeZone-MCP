using System;
using System.Collections.Generic;
using System.Linq;
using Controllers;
using Controllers.CharacterLogic;
using Controllers.Time;
using Convoy.Locations;
using Gameplay.GameResources;
using MapEssentials;
using MapOperator.Runtime.Geography.Coordinates;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

// Inspect only the current settlement's already loaded objects. In particular,
// ConvoysManager.Get is intentionally not called: it can read files and populate caches.
public sealed partial class Plugin
{
    private static object ConvoyTile(GoogleGeoTileCoordinate coordinate) => new
    {
        tx = coordinate.Tx,
        ty = coordinate.Ty,
        zoom = coordinate.Zoom
    };

    private object ReadConvoyLocations(JObject args)
    {
        var container = WorldContainer();
        var controller = container.TryResolve<ConvoyLocations>();
        var filter = IntelOptionalText(args, "location_type", 32);
        if (filter != null && !Enum.GetNames(typeof(LocationType)).Contains(filter))
            throw new BridgeException("invalid_location_type", "Use an exact LocationType name such as NeutralZone or FarmersZone.");
        var includeUnrevealed = (bool?)args["include_unrevealed"] ?? false;
        var recorded = (controller?.CurrentLocationsData ?? new List<ConvoyLocations.LocationData>())
            .GroupBy(location => location.coordinates).ToDictionary(group => group.Key, group => group.Last());
        var cached = controller?.CurrentLocations;
        var locations = new Dictionary<GoogleGeoTileCoordinate, LocationType>();
        if (includeUnrevealed && cached != null)
            foreach (var entry in cached) locations[entry.Key] = entry.Value;
        // Recorded names/hints are retained even if the asynchronous full cache is absent.
        foreach (var entry in recorded) locations[entry.Key] = entry.Value.locationType;
        var visited = SaveHandler.SaveData?.VisitedZonesByConvoy;
        var matching = locations.Where(entry => filter == null || entry.Value.ToString() == filter)
            .OrderBy(entry => entry.Key.Zoom).ThenBy(entry => entry.Key.Tx).ThenBy(entry => entry.Key.Ty).ToArray();
        var result = (JObject)IntelPage(args, "convoy_locations", matching.Select(entry =>
        {
            var hasRecord = recorded.TryGetValue(entry.Key, out var record);
            var name = hasRecord && !string.IsNullOrWhiteSpace(record.locationName) ? record.locationName : null;
            return (object)new
            {
                tile = ConvoyTile(entry.Key),
                location_type = entry.Value.ToString(),
                name,
                known_name = name != null,
                recorded_location = hasRecord,
                generic_hint = hasRecord ? (bool?)record.isGeneric : null,
                visited = visited == null ? (bool?)null : visited.Contains(new Vector2Int(entry.Key.Tx, entry.Key.Ty)),
                is_current_tile = entry.Key.Equals(Map.Coordinate)
            };
        }), new
        {
            available = controller != null && (cached != null || recorded.Count > 0),
            cache_loaded = cached != null,
            recorded_location_count = recorded.Count,
            cached_candidate_count = cached?.Count,
            include_unrevealed = includeUnrevealed,
            total_matching = matching.Length,
            coordinate_system = "Google geographic tile indices (tx, ty, zoom), not settlement world X/Z",
            scope = "Current settlement ConvoyLocations cache and recorded location hints. Does not load the departure ConvoyData or open the destination selector.",
            visibility = "Default lists recorded location hints only. recorded_location is not a fog-of-war sight flag. include_unrevealed adds already cached candidates without revealing them in-game.",
            visited_match = "Native visited records contain tile X/Y without a zoom; visited compares those two indices only.",
            note = "An empty/unavailable cache does not mean that the world has no NPC regions. No generation, download or discovery is triggered."
        });
        result["source"] = "live-game-existing-convoy-location-cache";
        return result;
    }

    private static object ConvoyCargoSummary(IEnumerable<ResourcesContainer> containers)
    {
        var totals = containers.Where(value => value != null).Distinct()
            .SelectMany(value => value.Resources).Where(entry => entry.Value > 0)
            .GroupBy(entry => entry.Key.ToString())
            .Select(group => new { resource_id = group.Key, quantity = group.Sum(entry => entry.Value) })
            .OrderBy(entry => entry.resource_id).ToArray();
        return new { total_resource_types = totals.Length, truncated = totals.Length > 100, items = totals.Take(100).ToArray() };
    }

    private object ReadConvoyStatus(JObject args)
    {
        var container = WorldContainer();
        var locations = container.TryResolve<ConvoyLocations>();
        var time = container.TryResolve<TimeController>();
        var visited = SaveHandler.SaveData?.VisitedZonesByConvoy;
        var visits = visited?.Distinct().ToArray() ?? Array.Empty<Vector2Int>();
        var playerSquads = squads.Squads.Where(group => group != null && !group.IsDestroying).ToArray();
        var playerIds = new HashSet<string>(playerSquads.Select(group => group.Id));
        var playerVehicles = container.Resolve<VehiclesController>().Vehicles
            .Where(vehicle => vehicle != null && vehicle.Owner != null && playerIds.Contains(vehicle.Owner.Id)).Distinct().ToArray();
        var livingSquadMembers = playerSquads.SelectMany(group => group.Characters)
            .Where(character => character != null && character.CharacterInfo != null && !character.IsDead())
            .Select(character => character.Id).Distinct().Count();
        var result = (JObject)IntelPage(args, "convoy_visited_zones", visits.Select((tile, index) => new
        {
            index,
            tile = new { tx = tile.x, ty = tile.y, zoom = (int?)null },
            matches_current_tile_xy = tile.x == Map.Coordinate.Tx && tile.y == Map.Coordinate.Ty
        }), new
        {
            convoy_id = Map.ConvoyID,
            is_convoy_map = Map.IsConvoy,
            is_special_convoy_start = Map.IsConvoyStart,
            map_mode = !Map.IsConvoy ? "standard_settlement" : Map.IsConvoyStart ? "special_convoy_start" : "migrated_convoy",
            has_main_hq = HqController.MainHeadquarter != null,
            awaiting_hq_setup = Map.IsConvoy && HqController.MainHeadquarter == null,
            current_tile = ConvoyTile(Map.Coordinate),
            current_location_type = NpcZoneController.SelectedLocationType.ToString(),
            current_game_day = TimeController.Day,
            days_from_previous_games = time?.DaysFromPreviousGames,
            visited_records_available = visited != null,
            total_visited_records = visits.Length,
            current_tile_in_visited_records = visited == null ? (bool?)null : visited.Contains(new Vector2Int(Map.Coordinate.Tx, Map.Coordinate.Ty)),
            recorded_location_count = locations?.CurrentLocationsData?.Count,
            location_cache_loaded = locations?.CurrentLocations != null,
            live_player_force = new
            {
                squad_count = playerSquads.Length,
                living_squad_members = livingSquadMembers,
                squad_owned_vehicle_count = playerVehicles.Length,
                squad_cargo = ConvoyCargoSummary(playerSquads.Select(group => group.ResourcesContainer)),
                owned_vehicle_cargo = ConvoyCargoSummary(playerVehicles.Select(vehicle => vehicle.Trunk)),
                scope = "Current living player squads and their currently owned vehicles. Excludes unowned mobile HQ vehicles, deployed HQ storage, civilians, stockpile, equipped items and fuel tanks. Not a departure manifest or a convoy readiness check."
            },
            departure_manifest_available = false,
            departure_manifest = (object)null,
            departure_readiness = (object)null,
            note = "Map.ConvoyID == '0' means a special new-game convoy start, not that a convoy is departing. Visited records may include the current map; their count is not the number of completed migrations. Old serialized convoy manifests are deliberately not loaded or presented as live state."
        });
        result["source"] = "live-game-and-in-memory-visited-records";
        return result;
    }
}
