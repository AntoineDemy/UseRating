using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.UserRatings.Configuration
{
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>Gets or sets how many items each "Recently rated" row shows (5-50).</summary>
        public int RecentlyRatedItemsCount { get; set; } = 10;
    }
}
