using System.Text.Json;

namespace DineroBook.CheckDesk;

/// <summary>Settings from settings.json next to the browser data
/// (%LOCALAPPDATA%\DineroBook\CheckDesk). Every key is optional.</summary>
public sealed class AppSettings
{
    public const string DefaultHome = "https://dinerobook.com/app/check-cashing";

    /// <summary>The page the window opens: check cashing, which opens on
    /// Cash a check.</summary>
    public string Home { get; init; } = DefaultHome;

    /// <summary>The Excella's feed mode: MANUAL (one check in the slot)
    /// or AUTOFEED.</summary>
    public string DocFeed { get; init; } = "MANUAL";

    /// <summary>A pretend scanner that returns a sample check, for trying
    /// the window on a computer without one.</summary>
    public bool DemoScanner { get; init; }

    public Uri HomeUri => new(Home);

    public static AppSettings Load(string? json)
    {
        AppSettings? s = null;
        if (!string.IsNullOrWhiteSpace(json))
        {
            try
            {
                s = JsonSerializer.Deserialize<AppSettings>(json, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                });
            }
            catch (JsonException)
            {
                s = null;
            }
        }
        s ??= new AppSettings();
        // Only an https address (or a local test server) may be home.
        if (!Uri.TryCreate(s.Home, UriKind.Absolute, out var home)
            || !(home.Scheme == Uri.UriSchemeHttps || home.IsLoopback))
        {
            s = new AppSettings { DocFeed = s.DocFeed, DemoScanner = s.DemoScanner };
        }
        var feed = s.DocFeed.ToUpperInvariant();
        if (feed != "MANUAL" && feed != "AUTOFEED") feed = "MANUAL";
        return new AppSettings { Home = s.Home, DocFeed = feed, DemoScanner = s.DemoScanner };
    }
}
