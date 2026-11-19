using System.Text.Json;

namespace DineroBook.Processor;

/// <summary>What the service is doing, as one word (the status page turns
/// it into a sentence).</summary>
public static class ProcessorState
{
    public const string Starting = "starting";
    public const string Idle = "idle";                     // nothing waiting
    public const string Sending = "sending";               // files going up
    public const string Waiting = "waiting";               // files not ready yet / paced
    public const string NotSignedIn = "not_signed_in";     // no agent key saved
    public const string KeyUnreadable = "key_unreadable";  // agent-key.bin will not decrypt here
    public const string KeyRejected = "key_rejected";      // 401
    public const string StoreClosed = "store_closed";      // 402 / 403
    public const string UpdateNeeded = "update_needed";    // the server refused the upload format
    public const string SettingsInvalid = "settings_invalid";
    public const string FolderUnavailable = "folder_unavailable";
    public const string RetryLater = "retry_later";        // 5xx / network / 429
    public const string Stopped = "stopped";
}

/// <summary>
/// state\status.json, rewritten whole by the service every few seconds and
/// read by the Manager. Never holds the key.
/// </summary>
public sealed class ProcessorStatus
{
    public string Version { get; set; } = "";
    public bool Running { get; set; }
    public string State { get; set; } = ProcessorState.Starting;
    public string Message { get; set; } = "";
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public string ApiUrl { get; set; } = "";
    public string WatchFolder { get; set; } = "";
    public string StoreName { get; set; } = "";

    public DateTimeOffset? LastUploadAt { get; set; }
    public string LastUploadFile { get; set; } = "";
    public string LastUploadResult { get; set; } = "";

    /// <summary>Files the server accepted today (this computer's day).</summary>
    public int TodayCount { get; set; }
    public string TodayDate { get; set; } = "";
    public int SentTotal { get; set; }
    public int SkippedTotal { get; set; }

    /// <summary>Matching files not sent yet (including ones still being
    /// written and ones being sent).</summary>
    public int Waiting { get; set; }

    /// <summary>Files being sent right now.</summary>
    public int Uploading { get; set; }

    /// <summary>When files of later business days are held back: the file
    /// of the older day they wait for, and why ("" when none).</summary>
    public string WaitingOn { get; set; } = "";

    public string LastError { get; set; } = "";
    public DateTimeOffset? LastErrorAt { get; set; }
    public DateTimeOffset? NextTryAt { get; set; }

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    public void Write(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        AtomicFile.WriteAllText(path, JsonSerializer.Serialize(this, Json));
    }

    public static ProcessorStatus? TryRead(string path)
    {
        try
        {
            var text = AtomicFile.TryReadShared(path);
            return string.IsNullOrWhiteSpace(text) ? null : JsonSerializer.Deserialize<ProcessorStatus>(text, Json);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
