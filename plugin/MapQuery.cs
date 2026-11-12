using System;
using System.Linq;
using Controllers;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

public sealed partial class Plugin
{
    private object ReadMapBuildings(JObject args)
    {
        var (offset, limit) = PageRange(args);
        var (route, radiusSquared) = ReadMapArea(args);
        var exclusions = args["exclude"] as JArray ?? new JArray();
        if (exclusions.Count > 2)
            throw new BridgeException("invalid_map_area", "Use at most two exclusion circles.");
        var excluded = exclusions.Select(token =>
        {
            var point = MapPoint(token);
            var radius = MapRadius((JObject)token);
            return (point, radiusSquared: radius * radius);
        }).ToArray();

        var buildings = WorldContainer().Resolve<BuildingsController>().Buildings
            .Where(building => building != null);
        if (route.Length > 0 || excluded.Length > 0)
        {
            buildings = buildings.Where(building =>
            {
                var center = building.CenterPosition;
                var point = new Vector2(center.x, center.z);
                return (route.Length == 0 || InMapCorridor(point, route, radiusSquared)) &&
                    !excluded.Any(circle => (point - circle.point).sqrMagnitude < circle.radiusSquared);
            });
        }

        if ((bool?)args["scavenge_only"] == true)
        {
            buildings = buildings.Where(building => building.CanScavenge() && !building.IsScavenged() && !building.IsStockroom());
            if (route.Length > 0)
            {
                buildings = buildings.OrderBy(building =>
                {
                    var center = building.CenterPosition;
                    return (new Vector2(center.x, center.z) - route[0]).sqrMagnitude;
                }).ThenBy(building => building.Id);
            }
            return ReadPage("buildings", offset, limit, buildings.Select(building => new
            {
                id = building.Id,
                position = Position(building.CenterPosition)
            }));
        }

        return ReadPage("buildings", offset, limit, buildings.Select(building => new
        {
            id = building.Id,
            osm_id = building.OsmId.ToString(),
            position = Position(building.CenterPosition),
            bounds = Bounds(building.AABB),
            completed = building.IsCompleted,
            can_scavenge = building.CanScavenge(),
            scavenged = building.IsScavenged(),
            stockroom = building.IsStockroom()
        }));
    }

    private static (Vector2[] route, float radiusSquared) ReadMapArea(JObject args)
    {
        var points = args["points"] as JArray;
        var scope = (string)args["scope"] ?? (points?.Count == 1 ? "nearby" : "route");
        if (scope == "full")
        {
            if (args["points"] != null || args["radius"] != null)
                throw new BridgeException("invalid_map_area", "Full scope uses no points or radius.");
            return (Array.Empty<Vector2>(), 0);
        }
        var count = points?.Count ?? 0;
        var valid = scope switch
        {
            "nearby" => count == 1,
            "route" => count is >= 2 and <= 32,
            _ => false
        };
        if (!valid)
            throw new BridgeException("invalid_map_area", "Nearby requires one X/Z point. Route requires 2–32 X/Z points.");
        var radius = MapRadius(args);
        return (points.Select(MapPoint).ToArray(), radius * radius);
    }

    private static Vector2 MapPoint(JToken token)
    {
        if (token is not JObject point)
            throw new BridgeException("invalid_map_area", "Each point must contain X/Z coordinates.");
        return new Vector2(Coordinate(point, "x"), Coordinate(point, "z"));
    }

    private static float MapRadius(JObject args)
    {
        var radius = Coordinate(args, "radius");
        if (radius is < 1 or > 500)
            throw new BridgeException("invalid_map_area", "Use a radius between 1 and 500 world units.");
        return radius;
    }

    private static bool InMapCorridor(Vector2 point, Vector2[] route, float radiusSquared)
    {
        if ((point - route[0]).sqrMagnitude <= radiusSquared)
            return true;

        for (var i = 1; i < route.Length; i++)
        {
            var start = route[i - 1];
            var segment = route[i] - start;
            var lengthSquared = segment.sqrMagnitude;
            if (lengthSquared == 0)
                continue;
            var fraction = Mathf.Clamp01(Vector2.Dot(point - start, segment) / lengthSquared);
            if ((point - (start + segment * fraction)).sqrMagnitude <= radiusSquared)
                return true;
        }
        return false;
    }
}
