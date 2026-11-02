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
        private readonly string _dataPath;
        private readonly ILogger<RatingRepository> _logger;
        private readonly object _lock = new();
        private readonly Dictionary<string, UserRating> _ratings;

        // Secondary index so item lookups don't scan every rating on the server.
        private readonly Dictionary<Guid, List<UserRating>> _byItem = new();

        public RatingRepository(IApplicationPaths appPaths, ILogger<RatingRepository> logger)
        {
            _logger = logger;
            _dataPath = Path.Combine(appPaths.PluginConfigurationsPath, "UserRatings", "ratings.json");
            Directory.CreateDirectory(Path.GetDirectoryName(_dataPath)!);
            _ratings = Load();
            foreach (var rating in _ratings.Values)
            {
                IndexAdd(rating);
            }
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
                return _byItem.TryGetValue(itemId, out var list)
                    ? list.OrderByDescending(r => r.Timestamp).ToList()
                    : new List<UserRating>();
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
                return _byItem
                    .Select(e => new RatedItemSummary
                    {
                        ItemId = e.Key,
                        AverageRating = e.Value.Average(r => r.Rating),
                        TotalRatings = e.Value.Count,
                        LastRated = e.Value.Max(r => r.Timestamp)
                    })
                    .OrderByDescending(s => s.LastRated)
                    .ToList();
            }
        }

        public void SaveRating(UserRating rating)
        {
            lock (_lock)
            {
                var key = GetKey(rating.ItemId, rating.UserId);
                if (_ratings.Remove(key, out var previous))
                {
                    IndexRemove(previous);
                }

                _ratings[key] = rating;
                IndexAdd(rating);
                Persist();
            }
        }

        public bool DeleteRating(Guid itemId, Guid userId)
        {
            lock (_lock)
            {
                if (!_ratings.Remove(GetKey(itemId, userId), out var removed))
                {
                    return false;
                }

                IndexRemove(removed);
                Persist();
                return true;
            }
        }

        public void DeleteAllRatings()
        {
            lock (_lock)
            {
                _ratings.Clear();
                _byItem.Clear();
                Persist();
            }
        }

        private static string GetKey(Guid itemId, Guid userId) => $"{itemId}_{userId}";

        // Caller must hold _lock (or be the constructor).
        private void IndexAdd(UserRating rating)
        {
            if (!_byItem.TryGetValue(rating.ItemId, out var list))
            {
                _byItem[rating.ItemId] = list = new List<UserRating>();
            }

            list.Add(rating);
        }

        // Caller must hold _lock.
        private void IndexRemove(UserRating rating)
        {
            if (_byItem.TryGetValue(rating.ItemId, out var list) && list.Remove(rating) && list.Count == 0)
            {
                _byItem.Remove(rating.ItemId);
            }
        }

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
            // Compact JSON, streamed straight to disk: no intermediate string.
            var tempPath = _dataPath + ".tmp";
            using (var stream = File.Create(tempPath))
            {
                JsonSerializer.Serialize(stream, _ratings);
            }

            File.Move(tempPath, _dataPath, overwrite: true);
        }
    }
}
