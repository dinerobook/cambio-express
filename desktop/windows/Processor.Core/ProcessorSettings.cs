using System.Text.Json;
using System.Text.Json.Serialization;

namespace DineroBook.Processor;

/// <summary>
/// settings.json: what the Manager set. Every key is optional. The agent
/// key itself is NOT here (agent-key.bin); the store fields only say which
/// store that key belongs to, for the status page.
/// <para>
/// Keys an older version wrote (<c>patterns</c>, <c>maxConcurrentUploads</c>)
/// are ignored: every file goes, and the server's rate limit is the only
/// limit on uploads at once (owner, 2026-11-18).
/// </para>
/// </summary>
public sealed class ProcessorSettings
{
    /// <summary>Passport's BOOutbox is always a network share on the
    /// Passport server, which sits at this address at Gilbarco sites (the
    /// owner's LdPosService install guide uses the same path).</summary>
    public const string DefaultWatchFolder = @"\\10.5.48.2\XMLGateway\BOOutBox";
    public const int DefaultPollSeconds = 5;

    public string ApiUrl { get; set; } = ServerContract.DefaultApiUrl;
    public string WatchFolder { get; set; } = DefaultWatchFolder;

    public int PollSeconds { get; set; } = DefaultPollSeconds;

    // Which store the saved key belongs to (written by the Manager on connect).
    public int? StoreId { get; set; }
    public string StoreName { get; set; } = "";
    public int? KeyId { get; set; }
    public string KeyLabel { get; set; } = "";
    public string ConnectedBy { get; set; } = "";
    public DateTimeOffset? ConnectedAt { get; set; }

    [JsonIgnore]
    public int EffectivePollSeconds => Math.Clamp(PollSeconds, 2, 300);

    internal static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    /// <summary>Reads settings.json. A missing file is the defaults; a file
    /// that is not valid JSON is the defaults plus a problem to show.</summary>
    public static ProcessorSettings Parse(string? json, out string problem)
    {
        problem = "";
        if (string.IsNullOrWhiteSpace(json)) return new ProcessorSettings();
        try
        {
            return JsonSerializer.Deserialize<ProcessorSettings>(json, Json) ?? new ProcessorSettings();
        }
        catch (JsonException ex)
        {
            problem = "settings.json could not be read (" + ex.Message + "); using the defaults.";
            return new ProcessorSettings();
        }
    }

    public static ProcessorSettings Load(DataPaths paths, out string problem) =>
        Parse(AtomicFile.TryReadShared(paths.Settings), out problem);

    public string ToJson() => JsonSerializer.Serialize(this, Json);

    public void Save(DataPaths paths)
    {
        Directory.CreateDirectory(paths.Root);
        AtomicFile.WriteAllText(paths.Settings, ToJson());
    }
}
