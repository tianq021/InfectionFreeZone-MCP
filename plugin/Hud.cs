using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Controllers;
using Controllers.Time;
using Gameplay.Units;
using Gameplay.Units.Enemy;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace IfzMcp;

public sealed partial class Plugin
{
    private static string hudMessage;
    private static double hudMessageUntil;
    private static double hudNextRefresh;
    private static string hudStatus = "";
    private static GUIStyle hudLabelStyle;
    private static GUIStyle hudMessageStyle;
    private const int HudFontSize = 17;
    private const float HudLineHeight = 24f;
    private const float HudWidth = 800f;
    private const float HudTop = 52f;
    private const int HudMessageCharsPerLine = 52;

    private object ShowHudMessage(JObject args)
    {
        var text = ((string)args["text"] ?? "").Trim();
        if (text.Length == 0 || text.Length > 500)
            throw new BridgeException("invalid_message", "Use 1-500 characters for the HUD message.");
        var seconds = (int?)args["seconds"] ?? 20;
        if (seconds is < 3 or > 3600) seconds = 20;
        hudMessage = text;
        hudMessageUntil = Now + seconds;
        Logger.LogInfo("[HUD] " + text);
        return new { message = text, seconds };
    }

    private static string ShortOrder(string order)
    {
        if (string.IsNullOrEmpty(order)) return "待命";
        if (order.Contains("MoveToBuilding")) return "进楼";
        if (order.Contains("MoveToConvoy")) return "进仓";
        if (order.Contains("TakeVehicle")) return "取车";
        if (order.Contains("Move")) return "移动";
        if (order.Contains("Follow")) return "跟随";
        if (order.Contains("Attack")) return "攻击";
        if (order.Contains("Scavenge")) return "搜刮";
        if (order.Contains("Replenish")) return "补给";
        if (order.Contains("Disband")) return "解散";
        if (order.Contains("Stay")) return "驻守";
        return order.Length > 8 ? order.Substring(0, 8) : order;
    }

    private static string ShortHostile(string type)
    {
        if (string.IsNullOrEmpty(type)) return "未知";
        if (type.StartsWith("hideout")) return type.Contains("dog") ? "犬巢" : type.Contains("bandit") ? "匪巢" : "感染巢";
        if (type.StartsWith("animal")) return "野兽";
        if (type.StartsWith("inf")) return type.Contains("dog") ? "感染犬" : "感染者";
        if (type.Contains("bandit")) return "土匪";
        if (type.Contains("immigrant")) return "移民";
        return type.Length > 8 ? type.Substring(0, 8) : type;
    }

    private static string ShortName(string name)
    {
        if (string.IsNullOrEmpty(name)) return "小队";
        name = name.Replace("我(用户)", "我");
        return name.Length > 8 ? name.Substring(0, 8) : name;
    }

    private void OnGUI()
    {
        try
        {
            if (bridge == null) return;
            var now = Now;
            if (now >= hudNextRefresh)
            {
                hudNextRefresh = now + 0.5;
                hudStatus = BuildHudStatus();
            }
            var hasStatus = !string.IsNullOrEmpty(hudStatus);
            var messageVisible = !string.IsNullOrEmpty(hudMessage) && now < hudMessageUntil;
            if (!hasStatus && !messageVisible) return;
            if (hudLabelStyle == null)
            {
                var font = Font.CreateDynamicFontFromOSFont(
                    new[] { "Microsoft YaHei", "Segoe UI", "Arial" }, HudFontSize);
                hudLabelStyle = new GUIStyle(GUI.skin.label)
                {
                    font = font,
                    fontSize = HudFontSize,
                    alignment = TextAnchor.UpperLeft,
                    wordWrap = false,
                    richText = false,
                };
                hudLabelStyle.normal.textColor = new Color(0.86f, 0.96f, 0.9f);
                hudMessageStyle = new GUIStyle(hudLabelStyle) { fontStyle = FontStyle.Bold, wordWrap = true };
                hudMessageStyle.normal.textColor = new Color(1f, 0.85f, 0.32f);
            }
            var statusLines = hasStatus ? hudStatus.Split('\n').Length : 0;
            var messageLines = messageVisible
                ? Mathf.Clamp(Mathf.CeilToInt((hudMessage.Length + 5f) / HudMessageCharsPerLine), 1, 3)
                : 0;
            var height = 12f + statusLines * HudLineHeight + (messageVisible ? messageLines * HudLineHeight + 8f : 0f);
            var panel = new Rect(12f, HudTop, HudWidth, height);
            GUI.color = new Color(0f, 0f, 0f, 0.64f);
            GUI.DrawTexture(panel, Texture2D.whiteTexture);
            GUI.color = Color.white;
            if (hasStatus)
                GUI.Label(new Rect(panel.x + 10f, panel.y + 6f, panel.width - 20f, statusLines * HudLineHeight), hudStatus, hudLabelStyle);
            if (messageVisible)
                GUI.Label(new Rect(panel.x + 10f, panel.y + panel.height - messageLines * HudLineHeight - 4f, panel.width - 20f, messageLines * HudLineHeight),
                    "AI: " + hudMessage, hudMessageStyle);
        }
        catch
        {
            // The HUD must never interfere with gameplay; swallow drawing errors.
        }
    }

    private string BuildHudStatus()
    {
        try
        {
            var lines = new List<string>();
            var builder = new StringBuilder();
            builder.Append("IFZ MCP | 第").Append(TimeController.Day).Append("天 ").Append(TimeController.Hour.ToString("0.0")).Append('h');
            builder.Append(TimeController.IsPaused ? " 暂停" : " 1×");
            if (lease.HasValue) builder.Append(" | 写:").Append(owner);
            lines.Add(builder.ToString());
            if (squads?.Squads != null)
            {
                foreach (var squad in squads.Squads.Where(item => item != null && !item.IsDestroying))
                {
                    var order = squad.OrdersHandlers?.OrdersQueue?.CurrentOrder?.GetType().Name;
                    var cargo = squad.ResourcesContainer?.Resources == null
                        ? 0f
                        : squad.ResourcesContainer.Resources.Where(item => item.Value > 0).Sum(item => item.Value);
                    var hp = 100f;
                    var living = squad.Characters?.Where(member => member != null && member.CharacterInfo != null).ToArray();
                    if (living != null && living.Length > 0)
                        hp = living.Min(member => member.Health?.Hp ?? 100f);
                    var vehicle = squad.VehicleHandler?.Vehicle == null ? "" : " [车]";
                    lines.Add($"{squad.Id} {ShortName(squad.GroupName)} {ShortOrder(order)}{vehicle} 货{cargo:0.#} 血{hp:0}");
                }
            }
            if (worldContainer != null && worldMap?.Generated == true && HqController.MainHeadquarter != null)
            {
                var hq = HqController.MainHeadquarter.Position;
                var nearest = worldContainer.Resolve<GroupsController>().Groups
                    .Where(group => group != null && !group.IsDestroying && !group.IsEmpty()
                        && group.Fraction != Fraction.Player && group.IsVisible())
                    .Select(group => new { group, distance = PlanarDistance(group.Position, hq) })
                    .OrderBy(row => row.distance)
                    .FirstOrDefault();
                lines.Add(nearest == null
                    ? "敌人: 无"
                    : $"敌人: {ShortHostile(nearest.group.Type)}x{nearest.group.Characters.Count} 距家{nearest.distance:0}m");
            }
            return string.Join("\n", lines);
        }
        catch
        {
            return "";
        }
    }
}
