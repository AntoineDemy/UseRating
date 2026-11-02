using System;

namespace Jellyfin.Plugin.UserRatings.Models
{
    /// <summary>
    /// A single user's rating of an item. This is the persisted shape (ratings.json).
    /// </summary>
    public class UserRating
    {
        public Guid ItemId { get; set; }

        public Guid UserId { get; set; }

        /// <summary>Gets or sets the rating, 1 to 5.</summary>
        public int Rating { get; set; }

        public string? Note { get; set; }

        public DateTime Timestamp { get; set; }

        /// <summary>Gets or sets the user name at rating time. Fallback when the user no longer exists.</summary>
        public string? UserName { get; set; }
    }

    /// <summary>
    /// Aggregate of all ratings for one item.
    /// </summary>
    public class RatedItemSummary
    {
        public Guid ItemId { get; set; }

        public double AverageRating { get; set; }

        public int TotalRatings { get; set; }

        public DateTime LastRated { get; set; }
    }
}
