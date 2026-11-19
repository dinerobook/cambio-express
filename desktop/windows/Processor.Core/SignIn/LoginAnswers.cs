using System.Text.Json;

namespace DineroBook.Processor.SignIn;

/// <summary>Which sign-in call an answer came from (a 401 means a wrong
/// password to the first, a wrong code to the others).</summary>
public enum LoginStep { Password, Code, RecoveryCode }

/// <summary>What a sign-in call answered. Classes, not records: a record's
/// generated ToString would print the tokens.</summary>
public abstract class LoginAnswer;

/// <summary>Full sign-in (LoginResponse with an access_token).</summary>
public sealed class SignedIn(string accessToken, string? refreshJti, int userId, string username,
    string fullName, string role, int? storeId, IReadOnlyList<string> permissions) : LoginAnswer
{
    public string AccessToken { get; } = accessToken;

    /// <summary>The sign-in's refresh row; /auth/logout ends the sign-in
    /// with it.</summary>
    public string? RefreshJti { get; } = refreshJti;

    public int UserId { get; } = userId;
    public string Username { get; } = username;
    public string FullName { get; } = fullName;
    public string Role { get; } = role;
    public int? StoreId { get; } = storeId;
    public IReadOnlyList<string> Permissions { get; } = permissions;

    public override string ToString() => $"SignedIn({Role}, store {StoreId})";
}

/// <summary>Password checked out; a 6-digit code (or a recovery code) must
/// follow with the pending token.</summary>
public sealed class NeedsCode(string pendingToken, bool hasRecoveryCodes) : LoginAnswer
{
    public string PendingToken { get; } = pendingToken;
    public bool HasRecoveryCodes { get; } = hasRecoveryCodes;

    public override string ToString() => "NeedsCode";
}

/// <summary>Two-step sign-in must be set up first, in the web app
/// (enroll_required, or the TOTP-enrollment 409).</summary>
public sealed class NeedsTwoStepSetup : LoginAnswer;

/// <summary>409 store_ambiguous: the same username and password work at
/// several stores; sign in again at the one chosen.</summary>
public sealed class ChooseAccount(IReadOnlyList<AccountChoice> accounts) : LoginAnswer
{
    public IReadOnlyList<AccountChoice> Accounts { get; } = accounts;
}

public sealed record AccountChoice(int? StoreId, string StoreName, string Role)
{
    public override string ToString() =>
        (StoreName.Length > 0 ? StoreName : StoreId is { } id ? $"Store {id}" : "DineroBook")
        + (Role.Length > 0 ? $" ({Role})" : "");
}

public enum RefusalReason { BadCredentials, BadCode, StoreDisabled, TooManyAttempts, ServerError, Unreachable, Unexpected }

public sealed class LoginRefused(RefusalReason reason, string message) : LoginAnswer
{
    public RefusalReason Reason { get; } = reason;
    public string Message { get; } = message;

    public override string ToString() => $"LoginRefused({Reason})";
}

/// <summary>
/// Reads the answers of /auth/login-cross-store, /auth/login,
/// /auth/login/totp and /auth/login/recovery (api/Modules/Auth/Controllers,
/// LoginResponse in Requests/login.py). The 401 text is ours and the same
/// for every cause, like the server's: it never says whether a username
/// exists.
/// </summary>
public static class LoginAnswers
{
    public const string InvalidCredentials = "Invalid username or password";
    public const string StoreDisabledMessage = "This store has been disabled. Contact support.";

    public static LoginAnswer Parse(int status, string? body, LoginStep step)
    {
        switch (status)
        {
            case 200:
                return ParseLoginResponse(body);
            case 401:
                return step switch
                {
                    LoginStep.Password => new LoginRefused(RefusalReason.BadCredentials, InvalidCredentials),
                    LoginStep.Code => new LoginRefused(RefusalReason.BadCode,
                        "That code did not work. Check the authenticator app and try again (after five minutes, start over)."),
                    _ => new LoginRefused(RefusalReason.BadCode,
                        "That recovery code did not work (each one works once). After five minutes, start over."),
                };
            case 403:
                var why = ErrorDetail.Text(body);
                return new LoginRefused(RefusalReason.StoreDisabled, why.Length > 0 ? why : StoreDisabledMessage);
            case 409:
                return ParseConflict(body);
            case 429:
                return new LoginRefused(RefusalReason.TooManyAttempts,
                    "Too many sign-in attempts from this network. Wait a minute and try again.");
            case >= 500:
                return new LoginRefused(RefusalReason.ServerError,
                    $"DineroBook had a problem (HTTP {status}). Try again in a minute.");
            default:
                var detail = ErrorDetail.Text(body);
                return new LoginRefused(RefusalReason.Unexpected,
                    $"DineroBook refused the sign-in (HTTP {status})" + (detail.Length > 0 ? ": " + detail : "."));
        }
    }

    private static LoginAnswer ParseLoginResponse(string? body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body ?? "");
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return Unexpected();
            if (Bool(r, "requires_totp"))
            {
                if (Bool(r, "enroll_required")) return new NeedsTwoStepSetup();
                var pending = Str(r, "pending_token");
                return pending.Length > 0 ? new NeedsCode(pending, Bool(r, "has_recovery_codes")) : Unexpected();
            }
            var token = Str(r, "access_token");
            if (token.Length == 0 || !r.TryGetProperty("user_id", out var uid) || uid.ValueKind != JsonValueKind.Number)
            {
                return Unexpected();
            }
            var refresh = Str(r, "refresh_jti");
            var perms = r.TryGetProperty("permissions", out var p) && p.ValueKind == JsonValueKind.Array
                ? p.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList()
                : new List<string>();
            return new SignedIn(token, refresh.Length > 0 ? refresh : null, uid.GetInt32(), Str(r, "username"),
                Str(r, "full_name"), Str(r, "role"), Int(r, "store_id"), perms);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or InvalidOperationException)
        {
            return Unexpected();
        }
    }

    private static LoginAnswer ParseConflict(string? body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body ?? "");
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("detail", out var detail))
            {
                if (detail.ValueKind == JsonValueKind.Object && Str(detail, "code") == "store_ambiguous"
                    && detail.TryGetProperty("stores", out var stores) && stores.ValueKind == JsonValueKind.Array)
                {
                    var choices = stores.EnumerateArray()
                        .Where(s => s.ValueKind == JsonValueKind.Object)
                        .Select(s => new AccountChoice(Int(s, "store_id"), Str(s, "store_name"), Str(s, "role")))
                        .ToList();
                    if (choices.Count > 0) return new ChooseAccount(choices);
                }
                // The other 409 (TotpEnrollmentRequired) carries a plain
                // sentence: two-step sign-in must be set up in the web app.
                if (detail.ValueKind == JsonValueKind.String) return new NeedsTwoStepSetup();
            }
        }
        catch (JsonException)
        {
        }
        return Unexpected();
    }

    private static LoginRefused Unexpected() =>
        new(RefusalReason.Unexpected, "DineroBook gave an answer this version does not understand. Update DineroBook Manager.");

    internal static bool Bool(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    internal static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    internal static int? Int(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
}
