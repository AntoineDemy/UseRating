using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.UserRatings.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>Gets or sets how many items each "Recently rated" row shows (5-50).</summary>
        public int RecentlyRatedItemsCount { get; set; } = 10;

        /// <summary>Gets or sets a value indicating whether item pages show which users have watched the item.</summary>
        public bool ShowWatchStatus { get; set; } = true;
    }
}
