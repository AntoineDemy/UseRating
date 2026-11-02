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

        /// <summary>Gets or sets every user's watch status, or null when watch status is disabled or not applicable.</summary>
        public IReadOnlyList<ViewerDto>? Viewers { get; set; }
    }

    public class ViewerDto
    {
        public Guid UserId { get; set; }

        public string UserName { get; set; } = string.Empty;

        public bool Played { get; set; }

        /// <summary>Gets or sets the progress (0-100) when partially watched, or episodes watched for a series/season.</summary>
        public double? PlayedPercentage { get; set; }

        public DateTime? LastPlayedDate { get; set; }
    }

    public class RatedItemsDto
    {
        public int RecentlyRatedItemsCount { get; set; }

        public IReadOnlyList<RatedItemSummary> Items { get; set; } = Array.Empty<RatedItemSummary>();
    }
}
