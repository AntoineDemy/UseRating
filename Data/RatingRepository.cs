using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.UserRatings.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.UserRatings.Data
{
    /// <summary>
    /// JSON-file backed rating store. Registered as a singleton: loaded once, written on every change.
    /// </summary>
    public class RatingRepository
    {
        private static readonly JsonSerializerOptions _jsonOptions = new() { WriteIndented = true };

        private readonly string _dataPath;
        private readonly ILogger<RatingRepository> _logger;
        private readonly object _lock = new();
        private readonly Dictionary<string, UserRating> _ratings;

        public RatingRepository(IApplicationPaths appPaths, ILogger<RatingRepository> logger)
        {
            _logger = logger;
            _dataPath = Path.Combine(appPaths.PluginConfigurationsPath, "UserRatings", "ratings.json");
            Directory.CreateDirectory(Path.GetDirectoryName(_dataPath)!);
            _ratings = Load();
        }

        public UserRating? GetRating(Guid itemId, Guid userId)
        {
            lock (_lock)
            {
                return _ratings.TryGetValue(GetKey(itemId, userId), out var rating) ? rating : null;
            }
        }

        public List<UserRating> GetRatingsForItem(Guid itemId)
        {
            lock (_lock)
            {
                return _ratings.Values
                    .Where(r => r.ItemId == itemId)
                    .OrderByDescending(r => r.Timestamp)
                    .ToList();
            }
        }

        public List<UserRating> GetRatingsForUser(Guid userId)
        {
            lock (_lock)
            {
                return _ratings.Values
                    .Where(r => r.UserId == userId)
                    .OrderByDescending(r => r.Timestamp)
                    .ToList();
            }
        }

        public List<RatedItemSummary> GetRatedItems()
        {
            lock (_lock)
            {
                return _ratings.Values
                    .GroupBy(r => r.ItemId)
                    .Select(g => new RatedItemSummary
                    {
                        ItemId = g.Key,
                        AverageRating = g.Average(r => r.Rating),
                        TotalRatings = g.Count(),
                        LastRated = g.Max(r => r.Timestamp)
                    })
                    .OrderByDescending(s => s.LastRated)
                    .ToList();
            }
        }

        public void SaveRating(UserRating rating)
        {
            lock (_lock)
            {
                _ratings[GetKey(rating.ItemId, rating.UserId)] = rating;
                Persist();
            }
        }

        public bool DeleteRating(Guid itemId, Guid userId)
        {
            lock (_lock)
            {
                if (!_ratings.Remove(GetKey(itemId, userId)))
                {
                    return false;
                }

                Persist();
                return true;
            }
        }

        public void DeleteAllRatings()
        {
            lock (_lock)
            {
                _ratings.Clear();
                Persist();
            }
        }

        private static string GetKey(Guid itemId, Guid userId) => $"{itemId}_{userId}";

        private Dictionary<string, UserRating> Load()
        {
            if (!File.Exists(_dataPath))
            {
                return new Dictionary<string, UserRating>();
            }

            try
            {
                var json = File.ReadAllText(_dataPath);
                return JsonSerializer.Deserialize<Dictionary<string, UserRating>>(json) ?? new Dictionary<string, UserRating>();
            }
            catch (Exception ex)
            {
                // Keep the unreadable file aside instead of silently overwriting it on next save.
                var backupPath = _dataPath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss");
                _logger.LogError(ex, "Could not read {Path}, moving it to {Backup}", _dataPath, backupPath);
                File.Move(_dataPath, backupPath);
                return new Dictionary<string, UserRating>();
            }
        }

        // Caller must hold _lock.
        private void Persist()
        {
            // Write to a temp file then swap, so a crash mid-write never truncates the data.
            var tempPath = _dataPath + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(_ratings, _jsonOptions));
            File.Move(tempPath, _dataPath, overwrite: true);
        }
    }
}
