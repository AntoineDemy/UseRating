using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.UserRatings.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.UserRatings
{
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        // Relative src so it resolves against /web/ and works behind a configured base URL.
        private const string ScriptElement = "<script plugin=\"UserRatings\" src=\"ConfigurationPage?name=ratings.js\" defer></script>";
        private static readonly Regex _scriptRegex = new("<script plugin=\"UserRatings\".*?</script>", RegexOptions.Singleline | RegexOptions.Compiled);

        private readonly IApplicationPaths _applicationPaths;
        private readonly ILogger<Plugin> _logger;

        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<Plugin> logger)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            _applicationPaths = applicationPaths;
            _logger = logger;

            UpdateIndexHtml(inject: true);
        }

        public static Plugin? Instance { get; private set; }

        public override string Name => "User Ratings";

        public override Guid Id => Guid.Parse("b8c5d3e7-4f6a-8b9c-1d2e-3f4a5b6c7d8e");

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = Name,
                    EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
                },
                new PluginPageInfo
                {
                    Name = "ratings.js",
                    EmbeddedResourcePath = GetType().Namespace + ".Configuration.ratings.js"
                }
            };
        }

        public override void OnUninstalling()
        {
            UpdateIndexHtml(inject: false);
            base.OnUninstalling();
        }

        /// <summary>
        /// Adds (or removes) the ratings.js script tag in jellyfin-web's index.html.
        /// </summary>
        private void UpdateIndexHtml(bool inject)
        {
            if (string.IsNullOrWhiteSpace(_applicationPaths.WebPath))
            {
                return;
            }

            var indexFile = Path.Combine(_applicationPaths.WebPath, "index.html");
            if (!File.Exists(indexFile))
            {
                _logger.LogWarning("Could not find {IndexFile}, ratings UI will not load", indexFile);
                return;
            }

            try
            {
                var original = File.ReadAllText(indexFile);
                if (inject && original.Contains(ScriptElement, StringComparison.Ordinal))
                {
                    return;
                }

                var contents = _scriptRegex.Replace(original, string.Empty);
                if (inject)
                {
                    var bodyClosing = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
                    if (bodyClosing == -1)
                    {
                        _logger.LogWarning("No </body> in {IndexFile}, ratings UI will not load", indexFile);
                        return;
                    }

                    contents = contents.Insert(bodyClosing, ScriptElement);
                }

                if (contents != original)
                {
                    File.WriteAllText(indexFile, contents);
                    _logger.LogInformation("{Action} User Ratings script in {IndexFile}", inject ? "Injected" : "Removed", indexFile);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogError(ex, "Could not update {IndexFile}. Make sure Jellyfin can write to its web directory", indexFile);
            }
        }
    }
}
