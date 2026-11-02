using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Mime;
using System.Security.Claims;
using Jellyfin.Plugin.UserRatings.Data;
using Jellyfin.Plugin.UserRatings.Models;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

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

        public RatingsController(
            RatingRepository repository,
            IUserManager userManager)
        {
            _repository = repository;
            _userManager = userManager;
        }

        /// <summary>All ratings for an item and the current user's own rating.</summary>
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
                Ratings = ratings
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
