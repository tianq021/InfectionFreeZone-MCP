using System;
using System.Collections.Generic;
using System.Linq;
using Controllers;
using EventsSystem;
using EventsSystem.Objectives;
using MapEssentials;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

/// <summary>
/// 任务（Mission）与目标（Objective）详情，以及按任务完成的作弊接口。
/// 现有 get_world_data(events) 只给出 目标类型/是否完成；
/// 这里补充：章节、限时、目标进度数字（击杀数/建筑数/窝点数）、地图标记位置。
/// </summary>
public sealed partial class Plugin
{
    private static EventsSystemController MissionController() =>
        WorldContainer().Resolve<EventsSystemController>();

    private static IEnumerable<object> MissionRows(bool includeTypes)
    {
        var container = WorldContainer();
        var controller = container.Resolve<EventsSystemController>();
        var markersController = container.Resolve<MarkersController>();
        var rows = new List<object>();
        foreach (var mission in controller.ActiveMissions)
        {
            if (mission == null) continue;
            var objectives = new List<object>();
            foreach (var expression in mission.ObjectiveExpressions)
            {
                var objective = expression?.objective;
                if (objective == null) continue;
                objectives.Add(new
                {
                    id = objective.Id,
                    type = objective.ObjectiveType.ToString(),
                    completed = objective.Completed,
                    optional = objective.Optional,
                    target_count = objective.targetCount,
                    characters_to_kill = objective.characterCountToKill,
                    killed_characters = objective.killedCharacterCount,
                    hideouts_target = objective.allHideoutsTargetCount,
                    hideouts_remaining = objective.allRemainingHideoutsCount,
                    buildings_visited = objective.buildingCountToVisitState
                });
            }
            var markerPositions = markersController.GetMarkersByMissionId(mission.Id)
                .OfType<EventMarker>()
                .Where(marker => marker != null && marker.gameObject.activeInHierarchy)
                .Select(marker => Position(marker.Position))
                .ToArray();
            rows.Add(new
            {
                id = mission.Id,
                title_key = mission.customDescription ? mission.customDescriptionId : mission.Id + "_title",
                description_key = mission.customDescription ? mission.customDescriptionId : null,
                chapter_id = mission.chapterId,
                linked_to_chapter = mission.linkedToChapter,
                blocking_new_zone = mission.blockingNewZoneIfOnActiveList,
                time_to_resolve = mission.TimeToResolve,
                time_to_resolve01 = mission.TimeToResolve01,
                objective_count = objectives.Count,
                markers = markerPositions,
                objectives
            });
        }
        if (includeTypes)
        {
            rows.Add(new
            {
                kind = "objective_types",
                types = Enum.GetNames(typeof(ObjectiveType))
            });
        }
        return rows;
    }

    private object ReadMissions(JObject args)
    {
        var includeTypes = (bool?)args["include_types"] ?? false;
        var rows = MissionRows(includeTypes).ToList();
        return new { count = rows.Count, missions = rows };
    }

    private object CheatCompleteMission(JObject args)
    {
        var missionId = Text(args, "mission_id", 80);
        var controller = MissionController();
        var mission = controller.ActiveMissions.FirstOrDefault(row =>
            row != null && string.Equals(row.Id, missionId, StringComparison.Ordinal));
        if (mission == null)
            throw new BridgeException("mission_not_found", "No active mission with that ID. Read get_missions first.");
        var completed = new List<object>();
        foreach (var expression in mission.ObjectiveExpressions)
        {
            var objective = expression?.objective;
            if (objective == null || objective.Completed) continue;
            objective.Complete();
            completed.Add(new { id = objective.Id, type = objective.ObjectiveType.ToString() });
        }
        return new
        {
            mission_id = mission.Id,
            completed_objectives = completed.Count,
            objectives = completed,
            still_active = controller.ActiveMissions.Any(row => row != null && row.Id == mission.Id)
        };
    }
}