using System.Linq;
using Controllers.Time;
using Controllers.Weather;
using Gameplay.Mood;
using JutsuGamesConfig.Runtime;
using Language;
using UnityEngine;

namespace IfzMcp;

public sealed partial class Plugin
{
    private object ReadCurrentWeather()
    {
        var controller = WorldContainer().Resolve<WeatherController>();
        var weather = controller.CurrentWeather ??
            throw new BridgeException("weather_not_ready", "Wait for the settlement weather to initialize.");
        var config = Configs.GetConfig<WeatherConfig>();
        var cloudCover = weather.clouds / 100f;
        return new
        {
            session_id = sessionId,
            source = "live-game",
            day = TimeController.Day,
            hour = TimeController.Hour,
            is_night = TimeController.IsNight(),
            season = controller.CurrentSeason.ToString(),
            temperature_c = controller.CurrentTemperature,
            sky = cloudCover >= config.heavyCloudsThreshold ? "overcast" :
                cloudCover > config.clearSkyCoverageThreshold ? "partly_cloudy" : "clear",
            cloud_cover_percent = weather.clouds,
            precipitation_type = weather.IsRaining() ? "rain" : weather.IsSnowing() ? "snow" : "none",
            precipitation_mm_per_hour = weather.precipitation,
            wind_speed_mps = weather.windStrength,
            wind_direction_degrees = weather.windDirection,
            frost = WeatherController.IsFrost,
            snow_on_ground = controller.IsSnow,
            full_moon = weather.isFullMoon,
            supermoon = weather.IsSuperMoon(),
            severe_storm = weather.IsMegaStorm()
        };
    }

    private object ReadMood()
    {
        var controller = WorldContainer().Resolve<MoodController>();
        var content = SaveHandler.SaveData.ContentStateController;
        if (!content.IsContentUnlocked("mood"))
            return new { session_id = sessionId, unlocked = false };

        var score = MoodController.CurrentMood;
        var trend = score > controller.RecentMood ? TrendLevel.Increasing :
            score < controller.RecentMood ? TrendLevel.Decreasing : TrendLevel.Constant;
        var causes = controller.MoodModifiers.GroupBy(modifier => modifier.MoodModifierId)
            .Where(group => group.Any(modifier => modifier.IsModifierVisible()))
            .Select(group => new
            {
                id = group.Key,
                description = group.Last(modifier => modifier.IsModifierVisible()).ModifierDescription,
                count = group.Count(),
                change_percent = Mathf.RoundToInt(group.Sum(modifier => modifier.ModifierValue)),
                remaining_game_hours = group.Where(modifier => !modifier.IsIndefinitely)
                    .Select(modifier => modifier.GetRemainingTime()).Where(hours => hours > 0f)
                    .Select(hours => (int?)Mathf.CeilToInt(hours)).LastOrDefault()
            }).Where(cause => cause.change_percent != 0).ToArray();
        return new
        {
            session_id = sessionId,
            unlocked = true,
            day = TimeController.Day,
            hour = TimeController.Hour,
            score,
            max_score = Configs.GetConfig<MoodConfig>().maxMood,
            level = controller.CurrentMoodLevel,
            level_name = controller.GetCurrentMoodLevelName(),
            description = controller.GetCurrentMoodLevelDescription(),
            trend = trend.ToString().ToLowerInvariant(),
            trend_name = LEManager.Get("Code.mood.trendLevel." + trend),
            causes,
            effects = new
            {
                worker_efficiency_change_percent = Mathf.RoundToInt(100f * (controller.GetCurrentWorkersEfficiencyModifier() - 1f)),
                birth_rate_change_percent = content.IsContentUnlocked("children_born")
                    ? (int?)Mathf.RoundToInt(100f * (controller.GetBirthRateModifier() - 1f)) : null
            }
        };
    }
}
