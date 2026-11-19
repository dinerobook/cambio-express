using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace DineroBook.Processor;

/// <summary>
/// settings.json: what the Manager set. Every key is optional. The agent
/// key itself is NOT here (agent-key.bin); the store fields only say which
/// store that key belongs to, for the status page.
/// </summary>
public sealed class ProcessorSettings
{
    public const string DefaultWatchFolder = @"C:\Passport\XMLGateway\BOOutbox";
    public const int DefaultPollSeconds = 5;

    /// <summary>Passport's journal (PJR) and every movement report it writes
    /// at day close — the same list as the Python agent's
    /// <c>agent.ini.example</c>.</summary>
    public static readonly IReadOnlyList<string> DefaultPatterns =
        ["PJR*.xml", "FGM*.xml", "ISM*.xml", "MCM*.xml", "MSM*.xml", "TLM*.xml", "TPM*.xml"];

    public string ApiUrl { get; set; } = ServerContract.DefaultApiUrl;
    public string WatchFolder { get; set; } = DefaultWatchFolder;

    /// <summary>File name patterns to send; null or empty means
    /// <see cref="DefaultPatterns"/>.</summary>
    public List<string>? Patterns { get; set; }

    public int PollSeconds { get; set; } = DefaultPollSeconds;

    // Which store the saved key belongs to (written by the Manager at sign-in).
    public int? StoreId { get; set; }
    public string StoreName { get; set; } = "";
    public int? KeyId { get; set; }
    public string KeyLabel { get; set; } = "";
    public string ConnectedBy { get; set; } = "";
    public DateTimeOffset? ConnectedAt { get; set; }

    private static readonly Regex SafePattern = new(@"^[A-Za-z0-9*?._\-]{1,64}$", RegexOptions.CultureInvariant);

    [JsonIgnore]
    public IReadOnlyList<string> EffectivePatterns =>
        Patterns is { Count: > 0 } p && p.All(x => x is not null && SafePattern.IsMatch(x))
            ? p
            : DefaultPatterns;

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
