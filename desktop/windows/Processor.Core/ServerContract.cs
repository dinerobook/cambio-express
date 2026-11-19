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

    // ── Agent keys (same controller; day_close.update on the token's store) ──

    /// <summary>POST <c>{label}</c> → 201 <c>{id, label, key}</c>.</summary>
    public const string AgentKeysPath = "/api/v2/posimport/agent-keys";

    /// <summary>POST /api/v2/posimport/agent-keys/{key_id}/revoke.</summary>
    public const string AgentKeyRevokePathFormat = "/api/v2/posimport/agent-keys/{0}/revoke";

    /// <summary>AgentKeyIssueRequest.label max_length.</summary>
    public const int MaxKeyLabelLength = 80;

    // ── Sign-in (api/Modules/Auth/Controllers) ──

    public const string LoginCrossStorePath = "/api/v2/auth/login-cross-store";
    public const string LoginPath = "/api/v2/auth/login";
    public const string LoginTotpPath = "/api/v2/auth/login/totp";
    public const string LoginRecoveryPath = "/api/v2/auth/login/recovery";
    public const string LogoutPath = "/api/v2/auth/logout";
    public const string MyStoresPath = "/api/v2/auth/my-stores";
    public const string SwitchStorePath = "/api/v2/auth/switch-store";
    public const string SessionStatusPath = "/api/v2/auth/session-status";

    /// <summary>Each sign-in route allows "10/minute;50/hour" per address.</summary>
    public const int SignInLimitPerMinute = 10;

    /// <summary>/auth/logout ends the sign-in named by this cookie (the
    /// <c>refresh_jti</c> of the login answer).</summary>
    public const string RefreshCookieName = "db_refresh_token";

    /// <summary>The permission the agent-key routes ask for.</summary>
    public const string AgentKeyPermission = "day_close.update";

    // ── Liveness (api/main.py :: health) ──

    public const string HealthPath = "/api/v2/health";
}
