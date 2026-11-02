using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Mime;
using System.Security.Claims;
#if JELLYFIN_10_11_OR_GREATER
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
#else
using Jellyfin.Data.Enums;
#endif
using Jellyfin.Plugin.UserRatings.Data;
using Jellyfin.Plugin.UserRatings.Models;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.UserRatings.Api
{
    /// <summary>
    /// User ratings API. The acting user is always taken from the auth token, never from the request.
    /// </summary>
    [ApiController]
    [Authorize]
    [Route("UserRatings")]
    [Produces(MediaTypeNames.Application.Json)]
    public class RatingsController : ControllerBase
    {
        public const int MaxNoteLength = 2000;

        // Same values as Jellyfin.Api's InternalClaimTypes.UserId / Policies.RequiresElevation,
        // which live in an assembly plugins can't reference.
        private const string UserIdClaim = "Jellyfin-UserId";
        private const string RequiresElevationPolicy = "RequiresElevation";

        private readonly RatingRepository _repository;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ILogger<RatingsController> _logger;

        public RatingsController(
            RatingRepository repository,
            IUserManager userManager,
            ILibraryManager libraryManager,
            IUserDataManager userDataManager,
            ILogger<RatingsController> logger)
        {
            _repository = repository;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
            _logger = logger;
        }

        /// <summary>All ratings for an item, the current user's own rating and who has watched it.</summary>
        [HttpGet("Items/{itemId}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ActionResult<ItemRatingsDto> GetItemRatings([FromRoute] Guid itemId)
        {
            var userId = GetCurrentUserId();
            var ratings = _repository.GetRatingsForItem(itemId).Select(ToDto).ToList();

            return new ItemRatingsDto
            {
                AverageRating = ratings.Count > 0 ? ratings.Average(r => r.Rating) : 0,
                TotalRatings = ratings.Count,
                MyRating = ratings.FirstOrDefault(r => r.UserId == userId),
                Ratings = ratings,
                Viewers = TryGetViewers(itemId, userId)
            };
        }

        /// <summary>Creates or replaces the current user's rating for an item.</summary>
        [HttpPost("Items/{itemId}")]
        [Consumes(MediaTypeNames.Application.Json)]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        public ActionResult<RatingDto> RateItem([FromRoute] Guid itemId, [FromBody] RateRequest request)
        {
            if (request.Rating is < 1 or > 5)
            {
                return BadRequest("Rating must be between 1 and 5.");
            }

            var note = string.IsNullOrWhiteSpace(request.Note) ? null : request.Note.Trim();
            if (note?.Length > MaxNoteLength)
            {
                return BadRequest($"Note must be at most {MaxNoteLength} characters.");
            }

            var userId = GetCurrentUserId();
            var rating = new UserRating
            {
                ItemId = itemId,
                UserId = userId,
                Rating = request.Rating,
                Note = note,
                Timestamp = DateTime.UtcNow,
                UserName = _userManager.GetUserById(userId)?.Username
            };

            _repository.SaveRating(rating);
            return ToDto(rating);
        }

        /// <summary>Deletes the current user's rating for an item.</summary>
        [HttpDelete("Items/{itemId}")]
        [ProducesResponseType(StatusCodes.Status204NoContent)]
        [ProducesResponseType(StatusCodes.Status404NotFound)]
        public ActionResult DeleteRating([FromRoute] Guid itemId)
        {
            return _repository.DeleteRating(itemId, GetCurrentUserId()) ? NoContent() : NotFound();
        }

        /// <summary>Summary of every rated item, most recently rated first.</summary>
        [HttpGet("Items")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ActionResult<RatedItemsDto> GetRatedItems()
        {
            return new RatedItemsDto
            {
                RecentlyRatedItemsCount = Plugin.Instance?.Configuration.RecentlyRatedItemsCount ?? 10,
                Items = _repository.GetRatedItems()
            };
        }

        /// <summary>All ratings made by the current user.</summary>
        [HttpGet("Me")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ActionResult<IEnumerable<RatingDto>> GetMyRatings()
        {
            return _repository.GetRatingsForUser(GetCurrentUserId()).Select(ToDto).ToList();
        }

        /// <summary>Deletes every rating on the server. Admin only.</summary>
        [HttpDelete]
        [Authorize(Policy = RequiresElevationPolicy)]
        [ProducesResponseType(StatusCodes.Status204NoContent)]
        public ActionResult DeleteAllRatings()
        {
            _repository.DeleteAllRatings();
            return NoContent();
        }

        /// <summary>Watch status is a nice-to-have: never let it break the ratings themselves.</summary>
        private List<ViewerDto>? TryGetViewers(Guid itemId, Guid currentUserId)
        {
            try
            {
                return GetViewers(itemId, currentUserId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not load watch status for item {ItemId}", itemId);
                return null;
            }
        }

        /// <summary>
        /// Watch status of every enabled user who can access the item, based on Jellyfin's own played data.
        /// Null when the feature is turned off or the item isn't something you watch.
        /// </summary>
        private List<ViewerDto>? GetViewers(Guid itemId, Guid currentUserId)
        {
            if (Plugin.Instance?.Configuration.ShowWatchStatus == false)
            {
                return null;
            }

            var item = _libraryManager.GetItemById(itemId);
            var currentUser = _userManager.GetUserById(currentUserId);
            if (item is not (Video or Series or Season) || currentUser is null || !item.IsVisible(currentUser))
            {
                return null;
            }

#if JELLYFIN_12_OR_GREATER
            var users = _userManager.GetUsers();
#else
            var users = _userManager.Users;
#endif
            return users
                .Where(u => !u.HasPermission(PermissionKind.IsDisabled) && item.IsVisible(u))
                .Select(u =>
                {
                    // The DTO variant also aggregates series/seasons (played = all episodes played).
                    var data = _userDataManager.GetUserDataDto(item, u);
                    return new ViewerDto
                    {
                        UserId = u.Id,
                        UserName = u.Username,
                        Played = data?.Played ?? false,
                        PlayedPercentage = data?.PlayedPercentage,
                        LastPlayedDate = data?.LastPlayedDate
                    };
                })
                .OrderByDescending(v => v.Played)
                .ThenByDescending(v => v.PlayedPercentage ?? 0)
                .ThenBy(v => v.UserName, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private Guid GetCurrentUserId()
        {
            var value = User.FindFirstValue(UserIdClaim);
            return Guid.TryParse(value, out var id) ? id : Guid.Empty;
        }

        private RatingDto ToDto(UserRating rating) => new()
        {
            ItemId = rating.ItemId,
            UserId = rating.UserId,
            // Prefer the live name so renames show up; fall back to the cached one for deleted users.
            UserName = _userManager.GetUserById(rating.UserId)?.Username ?? rating.UserName ?? "Unknown user",
            Rating = rating.Rating,
            Note = rating.Note,
            Timestamp = rating.Timestamp
        };
    }
}
