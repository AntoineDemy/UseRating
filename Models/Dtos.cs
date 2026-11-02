using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.UserRatings.Models
{
    public class RateRequest
    {
        public int Rating { get; set; }

        public string? Note { get; set; }
    }

    public class RatingDto
    {
        public Guid ItemId { get; set; }

        public Guid UserId { get; set; }

        public string UserName { get; set; } = string.Empty;

        public int Rating { get; set; }

        public string? Note { get; set; }

        public DateTime Timestamp { get; set; }
    }

    public class ItemRatingsDto
    {
        public double AverageRating { get; set; }

        public int TotalRatings { get; set; }

        public RatingDto? MyRating { get; set; }

        public IReadOnlyList<RatingDto> Ratings { get; set; } = Array.Empty<RatingDto>();
    }

    public class RatedItemsDto
    {
        public int RecentlyRatedItemsCount { get; set; }

        public IReadOnlyList<RatedItemSummary> Items { get; set; } = Array.Empty<RatedItemSummary>();
    }
}
