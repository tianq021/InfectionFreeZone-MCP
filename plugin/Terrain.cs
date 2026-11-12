using System;
using System.Collections.Generic;
using MapEssentials;
using Navigation;
using Newtonsoft.Json.Linq;
using Pathfinding;
using UnityEngine;
using Utilities;

namespace IfzMcp;

/// <summary>
/// 地形栅格：直接采样游戏的 A* recast 图（不加 tag 约束），按节点 Tag 分类：
/// 0 地面 / 2 水面 / 4 墙 / 6、7 建筑内 / 29、31 道路 / 其他 不可走。
/// 比逐点 get_navigation_point 快一两个数量级，并能识别水面与桥梁候选。
/// </summary>
public sealed partial class Plugin
{
    private const char KindGround = 'G';
    private const char KindRoad = 'R';
    private const char KindWater = 'W';
    private const char KindBuilding = 'B';
    private const char KindUnwalkable = 'X';
    private const char KindNoNode = '?';
    private const char KindBridge = 'b';
    private const char KindDetached = 'D';

    private object ReadTerrainGrid(JObject args)
    {
        WorldContainer();
        if (worldMap == null || worldMap.Generated != true)
            throw new BridgeException("world_not_ready", "Wait for the settlement map to finish loading.");
        if (!SafeAstarPath.TryGet(out var astarPath))
            throw new BridgeException("navigation_not_ready", "The navigation graph is not available yet.");

        var step = (float?)args["step"] ?? 50f;
        if (!float.IsFinite(step) || step is < 5f or > 300f)
            throw new BridgeException("invalid_step", "step must be between 5 and 300 world units.");
        var includeHeights = (bool?)args["include_heights"] ?? false;
        var maxCells = (int?)args["max_cells"] ?? 20000;
        if (maxCells is < 100 or > 60000)
            throw new BridgeException("invalid_max_cells", "max_cells must be between 100 and 60000.");

        var bound = Map.Bound;
        float Bound(string key, float fallback)
        {
            var token = (float?)args[key];
            return token.HasValue && float.IsFinite(token.Value) ? token.Value : fallback;
        }

        var minX = Mathf.Clamp(Bound("min_x", bound.xMin), bound.xMin, bound.xMax);
        var minZ = Mathf.Clamp(Bound("min_z", bound.yMin), bound.yMin, bound.yMax);
        var maxX = Mathf.Clamp(Bound("max_x", bound.xMax), minX, bound.xMax);
        var maxZ = Mathf.Clamp(Bound("max_z", bound.yMax), minZ, bound.yMax);

        var cols = Mathf.FloorToInt((maxX - minX) / step) + 1;
        var rows = Mathf.FloorToInt((maxZ - minZ) / step) + 1;
        if (cols < 1 || rows < 1)
            throw new BridgeException("invalid_bounds", "The requested area is smaller than one grid step.");
        if ((long)cols * rows > maxCells)
            throw new BridgeException("grid_too_large",
                $"Grid {cols}x{rows} exceeds max_cells {maxCells}; increase step or pass max_cells.");

        var constraint = NNConstraint.None;
        var graph = astarPath.data.recastGraph;
        var detachedLimit = step * 1.25f;

        var grid = new List<char[]>(rows);
        var kinds = new List<string>(rows);
        var heights = includeHeights ? new List<float[]>(rows) : null;
        var counts = new Dictionary<char, int>();
        var elevationMin = float.MaxValue;
        var elevationMax = float.MinValue;
        double elevationSum = 0;
        var elevationCount = 0;
        var bridges = new List<object>();

        for (var row = 0; row < rows; row++)
        {
            var z = minZ + row * step;
            var line = new char[cols];
            var heightRow = includeHeights ? new float[cols] : null;
            for (var col = 0; col < cols; col++)
            {
                var x = minX + col * step;
                var requested = new Vector3(x, 25f, z);
                var nearest = graph.GetNearest(requested, constraint);
                var node = nearest.node;
                var snap = PlanarDistance(requested, nearest.position);
                char kind;
                if (node == null)
                {
                    kind = KindNoNode;
                }
                else
                {
                    var tag = node.Tag;
                    if (tag == 2) kind = KindWater;
                    else if (tag == 29 || tag == 31) kind = KindRoad;
                    else if (tag == 6 || tag == 7) kind = KindBuilding;
                    else if (tag == 4) kind = KindUnwalkable;
                    else if (!node.Walkable) kind = KindUnwalkable;
                    else if (snap > detachedLimit) kind = KindDetached;
                    else kind = KindGround;
                }

                if (heightRow != null) heightRow[col] = Mathf.Round(nearest.position.y * 10f) / 10f;
                if (kind is not (KindWater or KindNoNode) && snap <= detachedLimit)
                {
                    var height = nearest.position.y;
                    if (float.IsFinite(height))
                    {
                        if (height < elevationMin) elevationMin = height;
                        if (height > elevationMax) elevationMax = height;
                        elevationSum += height;
                        elevationCount++;
                    }
                }
                counts[kind] = counts.TryGetValue(kind, out var existing) ? existing + 1 : 1;
                line[col] = kind;
            }
            grid.Add(line);
            kinds.Add(new string(line));
            if (heightRow != null) heights.Add(heightRow);
        }

        // 桥梁候选：道路节点两侧 2 格内出现水面
        for (var row = 0; row < rows; row++)
        {
            for (var col = 0; col < cols; col++)
            {
                if (grid[row][col] != KindRoad) continue;
                var spansWater =
                    WaterNear(grid, row, col, 0, 1) || WaterNear(grid, row, col, 0, -1) ||
                    WaterNear(grid, row, col, 1, 0) || WaterNear(grid, row, col, -1, 0);
                if (!spansWater) continue;
                grid[row][col] = KindBridge;
                bridges.Add(new
                {
                    x = Mathf.Round(minX + col * step),
                    z = Mathf.Round(minZ + row * step),
                    height = Mathf.Round(PathfindingUtils.GetNearestOnGround(
                        new Vector3(minX + col * step, 25f, minZ + row * step)).position.y * 10f) / 10f
                });
            }
        }
        for (var row = 0; row < rows; row++) kinds[row] = new string(grid[row]);

        int Count(char kind) => counts.TryGetValue(kind, out var value) ? value : 0;
        var cells = cols * rows;
        return new
        {
            step,
            cols,
            rows,
            cells,
            bounds = new { min_x = minX, min_z = minZ, max_x = maxX, max_z = maxZ },
            legend = "G=ground R=road W=water B=inside building X=wall/unwalkable D=detached/void ?=no node b=bridge",
            counts = new
            {
                ground = Count(KindGround),
                road = Count(KindRoad),
                water = Count(KindWater),
                building = Count(KindBuilding),
                unwalkable = Count(KindUnwalkable),
                no_node = Count(KindNoNode),
                detached = Count(KindDetached),
                bridge = Count(KindBridge)
            },
            elevation = includeHeights
                ? new
                {
                    min = elevationCount == 0 ? 0f : elevationMin,
                    max = elevationCount == 0 ? 0f : elevationMax,
                    mean = elevationCount == 0 ? 0f : (float)(elevationSum / elevationCount)
                }
                : null,
            bridges,
            rows_text = kinds,
            heights
        };
    }

    private static bool WaterNear(List<char[]> grid, int row, int col, int dz, int dx)
    {
        for (var distance = 1; distance <= 2; distance++)
        {
            var r = row + dz * distance;
            var c = col + dx * distance;
            if (r < 0 || c < 0 || r >= grid.Count || c >= grid[r].Length) return false;
            if (grid[r][c] == KindWater) return true;
        }
        return false;
    }
}
