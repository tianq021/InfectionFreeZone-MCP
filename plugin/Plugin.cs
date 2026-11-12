using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using BepInEx;
using Controllers;
using Controllers.Pausing;
using Controllers.Time;
using Gameplay.Units;
using Gameplay.Units.Orders;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UI.Clock;
using UnityEngine;
using UnityEngine.SceneManagement;
using ZenjectExtensions.Installers;

namespace IfzMcp;

[BepInPlugin("local.ifz.mcp", "IFZ MCP", "0.2.2")]
public sealed partial class Plugin : BaseUnityPlugin
{
    private const string SupportedIfzHash = "56464F9C355C350D3EB274CA2E56455CA629A00A7DC02774F4E99A125009DB8F";
    private static SquadsController squads;
    private static PauseController pauses;
    private static TimeSpeedSetter speed;
    private const int RecentOrderLimit = 8192;
    private readonly Dictionary<Guid, Move> moves = new();
    private readonly LinkedList<Move> activeMoves = new();
    private readonly Queue<Guid> finishedMoves = new();
    private PipeBridge bridge;
    private object headquarters;
    private SquadsController sessionSquads;
    private Guid? sessionId;
    private string saveRoot;
    private string gameMode;
    private Guid? lease;
    private string owner;
    private double leaseUntil;
    private Step step;
    private object lastStep;

    private static double Now => (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency;

    private void Awake()
    {
        try
        {
            var steamMarker = Path.Combine(Paths.ConfigPath, "ifz-mcp-steam.sid");
            string sid;
            string pipeName;
            if (File.Exists(steamMarker))
            {
                VerifySteamBuild();
                gameMode = "steam";
                pipeName = "infection-free-zone-mcp-steam-v1";
                sid = File.ReadAllText(steamMarker).Trim();
                saveRoot = Path.GetDirectoryName(SaveHandler.SavesDirPath);
            }
            else if (Environment.GetEnvironmentVariable("IFZ_MCP_TEST_COPY") == "1")
            {
                gameMode = "test";
                pipeName = "infection-free-zone-mcp-v1";
                sid = Environment.GetEnvironmentVariable("IFZ_MCP_USER_SID");
                saveRoot = Path.GetFullPath(Path.Combine(Paths.GameRootPath, "..", "test-data"));
                SetSavePath("SavesDirPath", "Saves");
                SetSavePath("SavesTempPath", "TempSaves");
            }
            else
            {
                throw new InvalidOperationException("Install Steam mode or start the test copy using Start-TestGame.ps1.");
            }
            var harmony = new Harmony("local.ifz.mcp");
            Capture(harmony, typeof(SquadsController), nameof(CaptureSquads));
            Capture(harmony, typeof(PauseController), nameof(CapturePauses));
            Capture(harmony, typeof(TimeSpeedSetter), nameof(CaptureSpeed));
            CaptureWorld(harmony);
            SceneManager.activeSceneChanged += OnSceneChanged;
            bridge = new PipeBridge(pipeName, sid, message => Logger.LogError(message));
            Logger.LogInfo("IFZ MCP 0.2.2 ready (" + gameMode + "). Save root: " + saveRoot);
        }
        catch (Exception ex)
        {
            Logger.LogError("IFZ MCP initialization failed: " + ex);
        }
    }

    private static void VerifySteamBuild()
    {
        using var assembly = File.OpenRead(Path.Combine(Paths.ManagedPath, "Ifz.dll"));
        using var sha = SHA256.Create();
        var hash = BitConverter.ToString(sha.ComputeHash(assembly)).Replace("-", "");
        if (hash != SupportedIfzHash)
            throw new InvalidOperationException("Unsupported Steam build. IFZ MCP expects build 26104777.");
    }

    private void SetSavePath(string fieldName, string directory)
    {
        var destination = Path.Combine(saveRoot, directory);
        Directory.CreateDirectory(destination);
        ref var field = ref AccessTools.StaticFieldRefAccess<string>(typeof(SaveHandler), fieldName);
        field = destination;
        if (!string.Equals(AccessTools.Field(typeof(SaveHandler), fieldName).GetValue(null), destination))
            throw new InvalidOperationException("Could not isolate " + fieldName);
    }

    private static void Capture(Harmony harmony, Type type, string callback)
    {
        var inject = AccessTools.Method(type, "Inject") ??
            throw new MissingMethodException(type.FullName, "Inject");
        harmony.Patch(inject, postfix: new HarmonyMethod(typeof(Plugin), callback));
    }

    private static void CaptureSquads(SquadsController __instance) => squads = __instance;
    private static void CapturePauses(PauseController __instance) => pauses = __instance;
    private static void CaptureSpeed(TimeSpeedSetter __instance) => speed = __instance;

    private void OnSceneChanged(Scene previous, Scene next) => ResetSession();

    private void OnApplicationFocus(bool focused)
    {
        if (!focused && step != null && !step.AllowBackground)
            FinishStep("focus_lost");
    }

    private void OnDestroy()
    {
        SceneManager.activeSceneChanged -= OnSceneChanged;
        bridge?.Dispose();
    }

    private void Update()
    {
        if (bridge == null) return;
        try
        {
            RefreshSession();
            UpdateMoves();
            if (lease.HasValue && Now >= leaseUntil)
            {
                FinishStep("lease_expired");
                lease = null;
            }
            if (step != null)
            {
                if (pauses.IsPopupPaused || pauses.IsUIPaused) FinishStep("ui_pause");
                else if (TimeController.IsPaused) FinishStep("game_paused");
                else if (step.UntilOrder is Guid until && (!moves.TryGetValue(until, out var order) || order.Terminal))
                    FinishStep(order == null ? "order_missing" : "order_ended");
                else if (Now >= step.Deadline) FinishStep("time_limit");
            }
            bridge.Pump(Dispatch);
        }
        catch (Exception ex)
        {
            Logger.LogError(ex);
            FinishStep("game_error");
        }
    }

    private void RefreshSession()
    {
        var currentHq = HqController.MainHeadquarter;
        if (!GameInitializer.IsGameStarted || SaveHandler.LoadingData ||
            currentHq == null || squads?.Squads == null || pauses == null || speed == null)
        {
            if (sessionId.HasValue) ResetSession();
            return;
        }
        if (sessionId.HasValue && ReferenceEquals(headquarters, currentHq) && ReferenceEquals(sessionSquads, squads))
            return;
        ResetSession();
        headquarters = currentHq;
        sessionSquads = squads;
        sessionId = Guid.NewGuid();
    }

    private void ResetSession()
    {
        FinishStep("session_changed");
        headquarters = null;
        sessionSquads = null;
        sessionId = null;
        moves.Clear();
        activeMoves.Clear();
        finishedMoves.Clear();
        worldCommands.Clear();
        finishedWorldCommands.Clear();
        lastStep = null;
    }

    private object Dispatch(string method, JObject args)
    {
        switch (method)
        {
            case "status":
                return new
                {
                    version = "0.2.2",
                    ready = sessionId.HasValue,
                    scene = SceneManager.GetActiveScene().name,
                    session_id = sessionId,
                    focused = Application.isFocused,
                    unity = Application.unityVersion,
                    mode = gameMode,
                    game_root = Paths.GameRootPath,
                    save_root = saveRoot,
                    control_owner = lease.HasValue ? owner : null
                };
            case "get_state":
                return Snapshot();
            case "get_world_data":
                RequireSession(args);
                return ReadWorld(args);
            case "get_map_buildings":
                RequireSession(args);
                return ReadMapBuildings(args);
            case "get_navigation_point":
                RequireSession(args);
                return ReadNavigationPoint(args);
            case "get_terrain_grid":
                RequireSession(args);
                return ReadTerrainGrid(args);
            case "get_building_info":
                RequireSession(args);
                return ReadBuildingInfo(args);
            case "get_scavenge_progress":
                RequireSession(args);
                return ReadScavengeProgress(args);
            case "find_buildings_by_poi":
                RequireSession(args);
                return FindBuildingsByPoi(args);
            case "get_expedition_tiles":
                RequireSession(args);
                return ReadExpeditionTiles(args);
            case "get_vehicle_map":
                RequireSession(args);
                return ReadVehicleMap(args);
            case "get_missions":
                RequireSession(args);
                return ReadMissions(args);
            case "acquire_control":
                var requestedOwner = Text(args, "owner", 40);
                if (lease.HasValue && ((string)args["lease"] != lease.Value.ToString() || requestedOwner != owner))
                    throw new BridgeException("control_busy", "Write lease held by " + owner);
                lease ??= Guid.NewGuid();
                owner = requestedOwner;
                leaseUntil = Now + 90;
                return new { owner, lease, expires_in_seconds = 90 };
            case "release_control":
                RequireLease(args);
                FinishStep("lease_released");
                lease = null;
                return new { released = true };
            case "get_order":
                RequireSession(args);
                return ReadMove(Id(args, "order_id")).Result();
            case "hud_message":
                return ShowHudMessage(args);
        }

        RequireSession(args);
        RequireLease(args);
        switch (method)
        {
            case "pause":
                FinishStep("requested_pause");
                speed.PauseGame();
                return Snapshot();
            case "move_squad":
                return QueueMove(args);
            case "set_stockpile_amount":
                return SetStockpileAmount(args);
            case "move_npc_group":
            case "attack_group":
            case "set_building_workers":
            case "equip_squad_member":
            case "refill_squad_member_ammo":
            case "scavenge_building":
            case "return_to_stockroom":
            case "take_vehicle":
                return ExecuteWorldCommand(method, args);
            case "advance":
                return StartStep(args);
            case "cheat_list":
            case "cheat_heal_squads":
            case "cheat_refill_ammo":
            case "cheat_add_resources":
            case "cheat_unlock_expedition":
            case "cheat_complete_missions":
            case "cheat_scavenge_all":
            case "cheat_set_time":
            case "cheat_spawn_squad":
            case "cheat_reveal_groups":
            case "cheat_complete_mission":
                return ExecuteCheat(method, args);
            default:
                throw new BridgeException("unknown_method", "Unknown bridge method.");
        }
    }

    private object Snapshot()
    {
        if (!sessionId.HasValue)
            return new { ready = false, scene = SceneManager.GetActiveScene().name };
        return new
        {
            ready = true,
            session_id = sessionId,
            focused = Application.isFocused,
            time = new
            {
                day = TimeController.Day,
                hour = TimeController.Hour,
                sunset = TimeController.SunsetHour,
                elapsed_game_seconds = TimeController.GameplayTime,
                paused = TimeController.IsPaused,
                gameplay_pause = pauses.IsGameplayPaused,
                popup_pause = pauses.IsPopupPaused,
                ui_pause = pauses.IsUIPaused
            },
            headquarters = Position(HqController.MainHeadquarter.Position),
            headquarters_id = StockroomId(HqController.MainHeadquarter),
            squads = squads.Squads.Where(squad => squad != null && !squad.IsDestroying).Select(squad => new
            {
                id = squad.Id.ToString(),
                name = squad.GroupName,
                position = Position(squad.Position),
                moving = squad.IsMoving,
                in_vehicle = squad.IsUsingVehicle,
                vehicle_id = squad.VehicleHandler.Vehicle == null ? null : squad.VehicleHandler.Vehicle.Id,
                idle = IsIdle(squad)
            }).ToArray(),
            advance = step != null ? new { state = "running" } : lastStep
        };
    }

    private object QueueMove(JObject args)
    {
        var requestId = Id(args, "request_id");
        var squadId = Text(args, "squad_id", 64);
        var x = Coordinate(args, "x");
        var z = Coordinate(args, "z");
        var replace = (bool?)args["replace_orders"] ?? false;
        if (moves.TryGetValue(requestId, out var previous))
        {
            if (previous.SquadId != squadId || previous.RequestX != x || previous.RequestZ != z ||
                previous.Replace != replace)
                throw new BridgeException("request_conflict", "The request_id was already used with different arguments.");
            return previous.Result();
        }
        if (step != null || !pauses.IsOnlyGameplayPaused)
            throw new BridgeException("pause_required", "Apply gameplay pause and close any popup before issuing a move.");
        var squad = FindSquad(squadId);
        if (!replace && !IsIdle(squad))
            throw new BridgeException("squad_unavailable", "Choose an idle, on-foot squad or explicitly replace its orders.");
        if (squad.IsOnExpedition())
            throw new BridgeException("squad_unavailable", "Choose a squad on the settlement map.");
        var requested = new Vector3(x, squad.Position.y, z);
        var distance = PlanarDistance(squad.Position, requested);
        if (distance < 6 || distance > 100)
            throw new BridgeException("target_out_of_range", "The point must be 6鈥?00 world units from the squad.");

        var target = FindGround(requested);
        var order = new MoveOrder(target, donUsePenalty: !squad.IsUsingVehicle);
        var move = new Move(requestId, squad, squadId, order, target, x, z, replace);
        moves.Add(requestId, move);
        activeMoves.AddLast(move);
        try
        {
            squad.OrdersHandlers.GiveOrder(order, clearOrders: replace);
            if (Contains(move)) move.State = "accepted";
            else move.State = "rejected";
        }
        catch
        {
            move.State = "submission_unknown";
            throw;
        }
        return move.Result();
    }

    private void UpdateMoves()
    {
        var node = activeMoves.First;
        while (node != null)
        {
            var move = node.Value;
            var next = node.Next;
            if (!move.Terminal)
            {
                if (move.Squad == null || move.Squad.IsDestroying)
                    move.State = "squad_lost";
                else if (Contains(move))
                    move.State = move.Squad.IsMoving ? "moving" : "accepted";
                else
                    move.State = PlanarDistance(move.Squad.Position, move.Target) <= 4 ? "arrived" : "ended_short_of_target";
            }
            if (move.Terminal)
            {
                activeMoves.Remove(node);
                finishedMoves.Enqueue(move.Id);
                if (finishedMoves.Count > RecentOrderLimit)
                    moves.Remove(finishedMoves.Dequeue());
            }
            node = next;
        }
    }

    private object StartStep(JObject args)
    {
        if (step != null)
            throw new BridgeException("advance_busy", "Wait for the active advance to finish.");
        var allowBackground = (bool?)args["allow_background"] == true && Application.runInBackground;
        if ((!Application.isFocused && !allowBackground) || pauses.IsUIPaused || pauses.IsPopupPaused)
            throw new BridgeException("game_blocked", "Bring the game to the foreground and dismiss any blocking UI.");
        var seconds = (int?)args["seconds"];
        if (seconds is < 1 or > 12 || !seconds.HasValue)
            throw new BridgeException("invalid_seconds", "Use a whole number of seconds between 1 and 12.");
        Guid? until = args["until_order_id"] == null ? null : Id(args, "until_order_id");
        if (until.HasValue && ReadMove(until.Value).Terminal)
            throw new BridgeException("order_ended", "The requested move has already ended.");
        leaseUntil = Now + 90;
        step = new Step(Now + seconds.Value, until, allowBackground, (bool?)args["keep_running"] == true);
        try
        {
            speed.SetNormalSpeed();
            if (TimeController.IsPaused)
                FinishStep("speed_locked");
        }
        catch
        {
            FinishStep("speed_error");
            throw;
        }
        return Snapshot();
    }

    private void FinishStep(string reason)
    {
        if (step == null) return;
        var keepRunning = step.KeepRunning;
        step = null;
        if (!keepRunning) speed?.PauseGame();
        lastStep = new { state = "stopped", reason, keep_running = keepRunning };
    }

    private Move ReadMove(Guid id)
    {
        if (!moves.TryGetValue(id, out var move))
            throw new BridgeException("order_not_found", "No such move in this session.");
        return move;
    }

    private void RequireSession(JObject args)
    {
        if (!sessionId.HasValue)
            throw new BridgeException("not_ready", "Load a test settlement with a headquarters.");
        if (Id(args, "session_id") != sessionId.Value)
            throw new BridgeException("stale_session", "The settlement changed. Read get_state again.");
    }

    private void RequireLease(JObject args)
    {
        if (!lease.HasValue || Id(args, "lease") != lease.Value)
            throw new BridgeException("lease_required", "Acquire the current write lease.");
    }

    private static bool IsIdle(Group squad) =>
        !squad.IsDestroying && !squad.IsMoving && !squad.IsUsingVehicle &&
        !squad.IsScavenging && !squad.IsInExchange && (squad.OrdersHandlers?.IsOrderQueueEmpty ?? false);

    private static bool Contains(Move move)
    {
        var queue = move.Squad.OrdersHandlers.OrdersQueue;
        return ReferenceEquals(queue.CurrentOrder, move.NativeOrder) ||
            queue.Orders.Any(order => ReferenceEquals(order, move.NativeOrder));
    }

    private static object Position(Vector3 point) => new { x = point.x, y = point.y, z = point.z };

    private static float PlanarDistance(Vector3 first, Vector3 second) =>
        new Vector2(first.x - second.x, first.z - second.z).magnitude;

    private static string Text(JObject args, string key, int limit)
    {
        var value = (string)args[key];
        if (string.IsNullOrWhiteSpace(value) || value.Length > limit)
            throw new BridgeException("invalid_argument", "Invalid " + key);
        return value;
    }

    private static Guid Id(JObject args, string key)
    {
        if (!Guid.TryParseExact((string)args[key], "D", out var id))
            throw new BridgeException("invalid_argument", "Expected a UUID for " + key);
        return id;
    }

    private static float Coordinate(JObject args, string key)
    {
        var value = (float?)args[key];
        if (!value.HasValue || float.IsNaN(value.Value) || float.IsInfinity(value.Value))
            throw new BridgeException("invalid_coordinate", "Expected a finite coordinate.");
        return value.Value;
    }

    private sealed class Move
    {
        public readonly Guid Id;
        public readonly Group Squad;
        public readonly string SquadId;
        public readonly MoveOrder NativeOrder;
        public readonly Vector3 Target;
        public readonly float RequestX;
        public readonly float RequestZ;
        public readonly bool Replace;
        public string State = "submission_unknown";
        public bool Terminal => State != "accepted" && State != "moving" && State != "submission_unknown";

        public Move(Guid id, Group squad, string squadId, MoveOrder nativeOrder, Vector3 target,
            float requestX, float requestZ, bool replace)
        {
            Id = id;
            Squad = squad;
            SquadId = squadId;
            NativeOrder = nativeOrder;
            Target = target;
            RequestX = requestX;
            RequestZ = requestZ;
            Replace = replace;
        }

        public object Result() => new
        {
            order_id = Id,
            squad_id = SquadId,
            state = State,
            terminal = Terminal,
            target = Position(Target),
            position = Squad == null ? null : Position(Squad.Position)
        };
    }

    private sealed class Step
    {
        public readonly double Deadline;
        public readonly Guid? UntilOrder;
        public readonly bool AllowBackground;
        public readonly bool KeepRunning;

        public Step(double deadline, Guid? untilOrder, bool allowBackground, bool keepRunning)
        {
            Deadline = deadline;
            UntilOrder = untilOrder;
            AllowBackground = allowBackground;
            KeepRunning = keepRunning;
        }
    }
}

