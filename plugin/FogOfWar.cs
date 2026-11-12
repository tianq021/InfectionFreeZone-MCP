using System.Linq;
using Gameplay.FogOfWar;
using Gameplay.Units;
using Gameplay.Units.Characters;
using MapEssentials;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

public sealed partial class Plugin
{
    private static Vector3 FogObserverPosition(FogOfWarObserver observer)
    {
        var character = observer.GetComponentInParent<Character>();
        if (character != null) return character.Position;
        var group = observer.GetComponentInParent<Group>();
        return group != null ? group.Position : observer.transform.position;
    }

    private static object ReadFogOfWar(JObject args)
    {
        WorldContainer();
        var map = Map.Bound;
        var x0 = (float?)args["min_x"] ?? map.xMin;
        var x1 = (float?)args["max_x"] ?? map.xMax;
        var z0 = (float?)args["min_z"] ?? map.yMin;
        var z1 = (float?)args["max_z"] ?? map.yMax;
        var cols = (int?)args["columns"] ?? 32;
        var rows = (int?)args["rows"] ?? 32;
        if (!float.IsFinite(x0) || !float.IsFinite(x1) || !float.IsFinite(z0) || !float.IsFinite(z1) ||
            x0 < map.xMin || x1 > map.xMax || z0 < map.yMin || z1 > map.yMax || x1 <= x0 || z1 <= z0 ||
            cols is < 1 or > 64 || rows is < 1 or > 64)
            throw new BridgeException("invalid_fog_grid", "Use a rectangle inside map bounds and 1–64 cells per axis.");

        var observers = Object.FindObjectsByType<FogOfWarObserver>(FindObjectsSortMode.None)
            .Where(observer => observer.isActiveAndEnabled && observer.DetectionEnabled && observer.Radius > 0)
            .Select(observer => (Position: FogObserverPosition(observer), RadiusSquared: observer.Radius * observer.Radius))
            .ToArray();
        var grid = new string[rows];
        var stepX = (x1 - x0) / cols;
        var stepZ = (z1 - z0) / rows;
        var covered = 0;
        for (var row = 0; row < rows; row++)
        {
            var cells = new char[cols];
            var z = z0 + (row + 0.5f) * stepZ;
            for (var col = 0; col < cols; col++)
            {
                var x = x0 + (col + 0.5f) * stepX;
                var visible = false;
                foreach (var observer in observers)
                {
                    var dx = observer.Position.x - x;
                    var dz = observer.Position.z - z;
                    if (dx * dx + dz * dz >= observer.RadiusSquared) continue;
                    visible = true;
                    break;
                }
                cells[col] = visible ? '.' : '#';
                if (visible) covered++;
            }
            grid[row] = new string(cells);
        }

        return new
        {
            source = "active_observer_radius_estimate",
            bounds = Bounds(Rect.MinMaxRect(x0, z0, x1, z1)),
            columns = cols,
            rows,
            observers = observers.Length,
            covered_samples = covered,
            fogged_samples = rows * cols - covered,
            grid,
            legend = ". = estimated sight coverage, # = outside coverage. Columns increase in X, rows increase in Z."
        };
    }
}
