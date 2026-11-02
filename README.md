<p align="center">
  <img src="assets/banner.png" alt="Jellyfin User Ratings: rate, review and discover with everyone on your server" width="100%">
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://jellyfin.org/"><img src="https://img.shields.io/badge/Jellyfin-10.9.0%2B-AA5CC3?logo=jellyfin&logoColor=white" alt="Jellyfin 10.9.0+"></a>
  <img src="https://img.shields.io/badge/.NET-8.0-512BD4?logo=dotnet&logoColor=white" alt=".NET 8">
  <img src="https://img.shields.io/badge/client-web%20UI-00A4DC" alt="Web UI">
</p>

A social rating system for Jellyfin. Users rate movies, shows and episodes from 1 to 5 stars and can add a note. Everyone on the server can then see those ratings on each item's page, and a **User Ratings** tab on the home screen lists everything that has been rated.

> **Note:** works in the **web UI** only (desktop and mobile browsers). Native apps (Android TV, Swiftfin, …) don't load plugin scripts.

<p align="center">
  <img src="assets/features.png" alt="Rate, compare, discover" width="100%">
</p>

---

## Features

**On item detail pages**
- ⭐ 1–5 star picker with labels (*Awful → Masterpiece*), keyboard accessible
- 💬 Optional note (up to 2000 characters, with a live counter)
- 📊 Score summary: the average, the number of ratings, and a breakdown of how many people gave each star count
- 👥 Every user's review with an avatar, their stars, their note and a relative date ("2 days ago")
- ✏️ Update or delete your own rating at any time
- 👀 *Who watched it*: every user with access to the item, grouped as watched / in progress / not watched, with their progress and their rating (uses Jellyfin's played status, so it works for movies, episodes, seasons and whole shows)

**User Ratings home tab**
- 📈 Server stats: titles rated, total ratings, overall average
- 🕒 *Recently rated* rows for movies, shows and episodes (row length is configurable)
- 🗂️ *All rated items* grid: filter by type, choose one of 8 sort orders, 24 items per page
- 🖼️ Native Jellyfin cards; episodes fall back to the series poster

**Under the hood**
- 🔒 Every endpoint requires authentication. The acting user comes from the session token, so nobody can rate on someone else's behalf
- ⚡ No polling and no page reloads: a single idempotent sync runs on navigation and DOM changes
- 💾 Ratings are stored in a plain JSON file, so nothing is written to Jellyfin's database

## Screenshots

> These screenshots come from an earlier version. The current UI uses Jellyfin's accent colours and adds the score breakdown.

| Rating panel | Ratings tab |
|---|---|
| <img src="screenshots/browser.png" alt="Rating panel" width="420"> | <img src="screenshots/view user ratings.png" alt="User Ratings tab" width="420"> |

<p align="center"><img src="screenshots/mobile_app.png" alt="Mobile browser" width="260"></p>

## Installation

### From the plugin repository

1. **Dashboard → Plugins → Repositories → +**
2. Add this URL:
   ```
   https://raw.githubusercontent.com/aG00Dtime/Jellyfin.Plugin.UserRating/main/manifest.json
   ```
3. **Catalog** → **User Ratings** → **Install**
4. Restart Jellyfin

### Manual

1. Build the plugin (see [Building](#building)) or download a release zip
2. Copy `Jellyfin.Plugin.UserRatings.dll` into `<jellyfin-config>/plugins/UserRatings/`
3. Restart Jellyfin

No setup is needed. After the restart, the ratings panel appears on detail pages and the **User Ratings** tab appears next to *Home / Favorites*.

## Usage

**Rate something**
1. Open a movie, show or episode in the web UI
2. Scroll to the **User Ratings** panel
3. Pick your stars, optionally write a note, then click **Post rating** (or **Update** if you have already rated it)

**Browse ratings**
1. On the home screen, open the **User Ratings** tab
2. Look through the *Recently rated* rows, or scroll down to *All rated items*
3. Filter by **All / Movies / Shows / Episodes** and pick a sort order:
   rating (high/low), title (A–Z/Z–A), recently or oldest rated, most or fewest ratings
4. Click a card to open the item

## Configuration

**Dashboard → Plugins → User Ratings**

| Setting | Range | Default | Effect |
|---|---|---|---|
| Recently rated items count | 5–50 | 10 | Number of items in each *Recently rated* row |
| Show who has watched each item | on/off | on | Shows the *Who watched it* section on item pages. Turn off if users shouldn't see each other's watch history |

## API

All endpoints require an authenticated Jellyfin session (`X-Emby-Token`). The acting user is taken from the token.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/UserRatings/Items/{itemId}` | An item's ratings, its average, the caller's own rating and `Viewers` (each user's watch status, `null` when disabled) |
| `POST` | `/UserRatings/Items/{itemId}` | Rate an item. Body: `{ "Rating": 1-5, "Note": "optional, max 2000 chars" }` |
| `DELETE` | `/UserRatings/Items/{itemId}` | Delete the caller's rating |
| `GET` | `/UserRatings/Items` | Summary of every rated item, plus the `RecentlyRatedItemsCount` setting |
| `GET` | `/UserRatings/Me` | Every rating the caller has made |
| `DELETE` | `/UserRatings` | Delete every rating (admin only) |

Ratings are stored in `<config>/plugins/configurations/UserRatings/ratings.json`.

## Building

The plugin targets **.NET 8** and Jellyfin **10.9**. If the .NET 8 SDK isn't installed locally, build in Docker:

```bash
docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet build -c Release -o /src/out
```

The output is `out/Jellyfin.Plugin.UserRatings.dll`.

```
Api/RatingsController.cs      REST endpoints
Data/RatingRepository.cs      JSON-backed storage (singleton)
Configuration/ratings.js      web UI: detail panel + home tab
Configuration/configPage.html dashboard settings page
assets/                       banner, feature art, icon sources (SVG)
```

To regenerate the artwork after editing an SVG:

```bash
rsvg-convert -w 2560 assets/banner.svg   -o assets/banner.png
rsvg-convert -w 2560 assets/features.svg -o assets/features.png
rsvg-convert -w 512  assets/icon.svg     -o icon.png
```

## Use cases

- **Family server:** check how everyone rated a film before movie night ("Dad gave it 5 stars, Mom gave it 3")
- **Friend group:** sort by *Most ratings* or *Rating: high to low* to find the crowd favourites
- **Shared library:** use notes as short reviews and spoiler-free recommendations

## License

MIT. See [LICENSE](LICENSE).

<p align="center"><img src="icon.png" width="64" alt=""><br><sub>Made for the Jellyfin community</sub></p>
