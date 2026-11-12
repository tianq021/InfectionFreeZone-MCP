using System;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using GameCustomization;
using Gameplay.Buildings;
using Gameplay.Units.Player.Workers.WorkSystem;
using Gameplay.Units.Player.Workers.WorkSystem.Signals;
using Gameplay.Units.Workers;
using Gameplay.Units.Workers.WorkSystem;
using Newtonsoft.Json.Linq;
using Settings;
using Zenject;

namespace IfzMcp;

public sealed partial class Plugin
{
    private sealed class WorkTaskId
    {
        public string Value { get; }
        public WorkTaskId(long id) => Value = id.ToString(CultureInfo.InvariantCulture);
    }

    private readonly ConditionalWeakTable<WorkBase, WorkTaskId> workTaskIds = new();
    private long nextWorkTaskId;

    private string WorkId(WorkBase work) => workTaskIds.GetValue(work, _ => new WorkTaskId(++nextWorkTaskId)).Value;

    private static string WorkforceMode(DiContainer container) => (WorkManagement)container.Resolve<GameCustomize>().WorkManagement switch
    {
        WorkManagement.Micromanagement => "manual",
        WorkManagement.Priorities => "priorities",
        _ => throw new BridgeException("workforce_not_ready", "Worker management has not been initialized.")
    };

    private static bool IsStaffableTask(WorkBase work) => !work.IsDone && (work.InitialMaxWorkers > 0 || work.MaxWorkers > 0);

    private object ReadWorkforce(JObject args)
    {
        var (offset, limit) = PageRange(args);
        var container = WorldContainer();
        var controller = container.Resolve<WorkController>();
        var mode = WorkforceMode(container);
        var available = controller.AvailableWorkers.Count;
        var tasks = controller.Works.Where(IsStaffableTask).ToArray();
        return new
        {
            session_id = sessionId,
            mode,
            alarm = controller.IsAlarm,
            available_workers = available,
            total = tasks.Length,
            offset,
            next_offset = (long)offset + limit < tasks.Length ? offset + limit : (int?)null,
            items = tasks.Skip(offset).Take(limit).Select(work => ReadWorkTask(work, available, mode)).ToArray()
        };
    }

    private object ReadWorkTask(WorkBase work, int available, string mode)
    {
        var structure = work.GetRelatedStructure();
        var canExecute = work.CanExecute();
        var vacancies = Math.Max(0, work.MaxWorkers - work.Workers.Count);
        return new
        {
            task_id = WorkId(work),
            task_type = work.GetType().Name,
            employment = work.EmploymentType().ToString(),
            building_id = (structure as Building)?.Id,
            structure_type = structure?.Draft?.Id,
            area_type = (work as AreaWork)?.AreaWorkType?.Name,
            position = Position(work.GetPosition()),
            assigned_workers = work.Workers.Count,
            working_workers = work.WorkersWorking,
            max_workers = work.MaxWorkers,
            capacity = work.InitialMaxWorkers,
            vacancies,
            assignable_now = (mode == "manual" || (canExecute && !work.IsPaused && !work.IsSuspended && work.Priority > 0))
                ? Math.Min(available, vacancies) : 0,
            can_execute = canExecute,
            paused = work.IsPaused,
            suspended = work.IsSuspended,
            priority = mode == "priorities" ? work.Priority : (int?)null
        };
    }

    private object UpdateWorkTask(JObject args)
    {
        var container = WorldContainer();
        var controller = container.Resolve<WorkController>();
        var mode = WorkforceMode(container);
        if (Text(args, "mode", 12) != mode)
            throw new BridgeException("workforce_mode_changed", "Read get_workforce again before changing a task.");

        var taskId = Text(args, "task_id", 24);
        var work = controller.Works.FirstOrDefault(candidate => workTaskIds.TryGetValue(candidate, out var id) && id.Value == taskId);
        if (work == null || !IsStaffableTask(work))
            throw new BridgeException("work_unavailable", "This task has ended or changed. Read get_workforce again.");

        var setting = Text(args, "setting", 24);
        var (before, max) = (mode, setting) switch
        {
            ("manual", "assigned_workers") => (work.Workers.Count, work.MaxWorkers),
            ("priorities", "max_workers") => (work.MaxWorkers, work.InitialMaxWorkers),
            ("priorities", "priority") => (work.Priority, 5),
            _ => throw new BridgeException("workforce_setting_unavailable", "Use assigned_workers in manual mode, or max_workers and priority in priorities mode.")
        };
        var target = (int?)args["value"];
        var expected = (int?)args["expected_value"];
        if (!expected.HasValue || expected < 0 || !target.HasValue || target < 0 || target > max || (setting == "priority" && target == 0))
            throw new BridgeException("invalid_workers", "Use a value within the task's limits. Normal priorities run from 1 to 5.");
        if (before != expected)
            throw new BridgeException("workers_changed", "The task changed. Read get_workforce again and reconsider the adjustment.");

        var nativeTarget = setting == "priority" && before > 5 ? target.Value + 5 : target.Value;
        if (before != nativeTarget)
        {
            switch (setting)
            {
                case "assigned_workers":
                    var delta = target.Value - before;
                    if (delta > 0)
                    {
                        if (delta > controller.AvailableWorkers.Count)
                            throw new BridgeException("workers_unavailable", "There are too few available workers. Read get_workforce again.");
                        container.Resolve<SignalBus>().Fire(new AssignWorkersSignal(work, delta));
                    }
                    else
                    {
                        for (var i = 0; i < -delta && work.Workers.Count > target.Value; i++) work.RemoveWorker();
                    }
                    break;
                case "max_workers":
                    work.MaxWorkers = target.Value;
                    break;
                case "priority":
                    if (work.MaxWorkers == 0)
                        throw new BridgeException("priority_unavailable", "Give the task a positive worker limit before setting its priority.");
                    container.Resolve<SignalBus>().Fire(new WorkPriorityChangedSignal(work, nativeTarget, false));
                    break;
            }
        }

        var available = controller.AvailableWorkers.Count;
        return new { mode, setting, before, requested_value = target.Value, available_workers = available, task = ReadWorkTask(work, available, mode) };
    }
}
