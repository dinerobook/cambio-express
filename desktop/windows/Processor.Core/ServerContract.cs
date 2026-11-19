namespace DineroBook.Processor;

/// <summary>
/// The server's side of the deal, copied by hand from the Python code it
/// names. <c>tests/Modules/PosImport/test_processor_contract.py</c> reads
/// this file and fails when a value here no longer matches the server, or
/// when a path here is not a route the server has.
/// </summary>
public static class ServerContract
{
    /// <summary>Where a new install points. Anything else must be https
    /// (or a test server on this computer, see <see cref="ApiAddress"/>).</summary>
    public const string DefaultApiUrl = "https://dinerobook.com";

    // ── Upload (api/Modules/PosImport/Controllers :: agent_upload_route) ──

    /// <summary>POST, JSON <c>{filename, content_base64}</c>, header
    /// <see cref="AgentKeyHeader"/>. Idempotent per filename.</summary>
    public const string UploadPath = "/api/v2/posimport/agent/upload";

    public const string AgentKeyHeader = "X-Agent-Key";

    /// <summary>api/Modules/PosImport/Services/agent.py :: MAX_AGENT_FILE_BYTES.</summary>
    public const int MaxFileBytes = 4194304;

    /// <summary>AgentUploadRequest.filename max_length.</summary>
    public const int MaxFilenameLength = 120;

    /// <summary>api/Modules/PosImport/Services/agent.py :: KEY_PREFIX.</summary>
    public const string AgentKeyPrefix = "pak_";

    /// <summary>The upload route's limit, "120/minute;6000/hour", counted per
    /// public address. <see cref="UploadPacer"/> stays well under it.</summary>
    public const int UploadLimitPerMinute = 120;
    public const int UploadLimitPerHour = 6000;

    /// <summary>The 422 the upload route answers for content that is not
    /// base64, after the key checked out and before anything is stored.
    /// "Test connection" uses it to check a key without sending a file.</summary>
    public const string NotBase64Detail = "content_base64 is not valid base64.";

    // ── Connect (same controller :: agent_pair_route) ──

    /// <summary>POST <c>{code, label}</c>, optional <see cref="AgentKeyHeader"/>
    /// (the computer's previous key, revoked) → 200 <c>{id, label, key,
    /// store_id, store_name, connected_by}</c>. Public: the one-time connect
    /// code made on the Register import page is the credential, so nobody at
    /// the store types a name or a password.</summary>
    public const string PairPath = "/api/v2/posimport/agent/pair";

    /// <summary>The connect route's limit, "10/minute;50/hour" per address.</summary>
    public const int PairLimitPerMinute = 10;

    /// <summary>AgentPairRequest.label max_length.</summary>
    public const int MaxKeyLabelLength = 80;

    // ── Liveness (api/main.py :: health) ──

    public const string HealthPath = "/api/v2/health";
}
