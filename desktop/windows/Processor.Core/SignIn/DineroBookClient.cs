using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace DineroBook.Processor.SignIn;

/// <summary>The answer of a signed-in call: a value, or why not.</summary>
public sealed class ApiResult<T>
{
    private ApiResult(T? value, int? status, string message)
    {
        Value = value;
        Status = status;
        Message = message;
    }

    public T? Value { get; }

    /// <summary>The HTTP status, null when the server was not reached.</summary>
    public int? Status { get; }

    public string Message { get; }
    public bool Ok => Value is not null;

    public static ApiResult<T> Success(T value, int status) => new(value, status, "");
    public static ApiResult<T> Failure(int? status, string message) => new(default, status, message);
}

/// <summary>A row of GET /auth/my-stores (SwitchableStoreRow).</summary>
public sealed record StoreChoice(int StoreId, string Name, string Address, bool IsHome)
{
    public override string ToString() => Address.Length > 0 ? $"{Name} — {Address}" : Name;
}

/// <summary>POST /auth/switch-store (SwitchStoreResponse). A class: the
/// token must never reach a generated ToString.</summary>
public sealed class StoreToken(string accessToken, int storeId, string storeName)
{
    public string AccessToken { get; } = accessToken;
    public int StoreId { get; } = storeId;
    public string StoreName { get; } = storeName;

    public override string ToString() => $"StoreToken(store {StoreId})";
}

/// <summary>The parts of GET /auth/session-status the Manager reads.</summary>
public sealed record SessionInfo(string StoreName, IReadOnlyList<string> Permissions);

/// <summary>POST /posimport/agent-keys (AgentKeyIssueResponse).</summary>
public sealed class IssuedKey(int id, string label, string key)
{
    public int Id { get; } = id;
    public string Label { get; } = label;

    /// <summary>The raw key, shown by the server exactly once.</summary>
    public string Key { get; } = key;

    public override string ToString() => $"IssuedKey({Id}, {Label})";
}

/// <summary>
/// The DineroBook calls the Manager makes, with the shapes of
/// api/Modules/Auth and api/Modules/PosImport. The sign-in's access token
/// travels as a Bearer header taken from the JSON answer; no cookie is kept
/// (the logout call names the sign-in with its refresh_jti).
/// </summary>
public sealed class DineroBookClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly Uri _api;

    public DineroBookClient(Uri apiBase, string userAgent, HttpMessageHandler? handler = null)
    {
        _api = apiBase;
        _http = Http.Create(userAgent, TimeSpan.FromSeconds(30), handler);
    }

    public Uri ApiBase => _api;

    public void Dispose() => _http.Dispose();

    // ── Sign-in ──

    public Task<LoginAnswer> LoginCrossStoreAsync(string username, string password, CancellationToken ct) =>
        LoginAsync(ServerContract.LoginCrossStorePath, w =>
        {
            w.WriteString("username", username);
            w.WriteString("password", password);
        }, LoginStep.Password, ct);

    /// <summary>/auth/login at one store (the store_ambiguous follow-up).</summary>
    public Task<LoginAnswer> LoginAtStoreAsync(string username, string password, int? storeId, CancellationToken ct) =>
        LoginAsync(ServerContract.LoginPath, w =>
        {
            w.WriteString("username", username);
            w.WriteString("password", password);
            if (storeId is { } id) w.WriteNumber("store_id", id);
            else w.WriteNull("store_id");
        }, LoginStep.Password, ct);

    public Task<LoginAnswer> LoginTotpAsync(string pendingToken, string code, CancellationToken ct) =>
        LoginAsync(ServerContract.LoginTotpPath, w =>
        {
            w.WriteString("pending_token", pendingToken);
            w.WriteString("code", code);
        }, LoginStep.Code, ct);

    public Task<LoginAnswer> LoginRecoveryAsync(string pendingToken, string code, CancellationToken ct) =>
        LoginAsync(ServerContract.LoginRecoveryPath, w =>
        {
            w.WriteString("pending_token", pendingToken);
            w.WriteString("code", code);
        }, LoginStep.RecoveryCode, ct);

    private async Task<LoginAnswer> LoginAsync(string path, Action<Utf8JsonWriter> body, LoginStep step, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, ApiAddress.Combine(_api, path))
            {
                Content = Json(body),
            };
            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            if (Http.IsRedirect(response)) return new LoginRefused(RefusalReason.Unexpected, Http.RedirectDetail(response));
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return LoginAnswers.Parse((int)response.StatusCode, text, step);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            return new LoginRefused(RefusalReason.Unreachable, "Could not reach DineroBook: " + UploadAnswers.Describe(ex));
        }
    }

    /// <summary>Ends the sign-in on the server (its refresh rows are
    /// revoked, so the access token stops working at once too). Best
    /// effort: a failure here is reported, never thrown.</summary>
    public async Task<bool> LogoutAsync(string? refreshJti, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(refreshJti)) return false;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, ApiAddress.Combine(_api, ServerContract.LogoutPath));
            request.Headers.TryAddWithoutValidation("Cookie", ServerContract.RefreshCookieName + "=" + refreshJti);
            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            return (int)response.StatusCode is 200 or 204;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or OperationCanceledException)
        {
            return false;
        }
    }

    // ── Signed-in calls ──

    public async Task<ApiResult<IReadOnlyList<StoreChoice>>> MyStoresAsync(string accessToken, CancellationToken ct)
    {
        var (status, text, error) = await SendAsync(HttpMethod.Get, ServerContract.MyStoresPath, accessToken, null, ct).ConfigureAwait(false);
        if (error is not null) return ApiResult<IReadOnlyList<StoreChoice>>.Failure(status, error);
        if (status != 200) return ApiResult<IReadOnlyList<StoreChoice>>.Failure(status, Refusal(status!.Value, text, "list your stores"));
        try
        {
            using var doc = JsonDocument.Parse(text);
            if (!doc.RootElement.TryGetProperty("stores", out var stores) || stores.ValueKind != JsonValueKind.Array)
            {
                return ApiResult<IReadOnlyList<StoreChoice>>.Failure(status, "Unexpected answer listing your stores.");
            }
            var list = new List<StoreChoice>();
            foreach (var s in stores.EnumerateArray())
            {
                if (LoginAnswers.Int(s, "store_id") is not { } id) continue;
                list.Add(new StoreChoice(id, LoginAnswers.Str(s, "name"), LoginAnswers.Str(s, "address"), LoginAnswers.Bool(s, "is_home")));
            }
            return ApiResult<IReadOnlyList<StoreChoice>>.Success(list, 200);
        }
        catch (JsonException)
        {
            return ApiResult<IReadOnlyList<StoreChoice>>.Failure(status, "Unexpected answer listing your stores.");
        }
    }

    public async Task<ApiResult<StoreToken>> SwitchStoreAsync(string accessToken, int storeId, CancellationToken ct)
    {
        var (status, text, error) = await SendAsync(HttpMethod.Post, ServerContract.SwitchStorePath, accessToken,
            w => w.WriteNumber("store_id", storeId), ct).ConfigureAwait(false);
        if (error is not null) return ApiResult<StoreToken>.Failure(status, error);
        if (status != 200) return ApiResult<StoreToken>.Failure(status, Refusal(status!.Value, text, "open that store"));
        try
        {
            using var doc = JsonDocument.Parse(text);
            var r = doc.RootElement;
            var token = LoginAnswers.Str(r, "access_token");
            var id = LoginAnswers.Int(r, "store_id");
            if (token.Length == 0 || id is null) return ApiResult<StoreToken>.Failure(status, "Unexpected answer opening the store.");
            return ApiResult<StoreToken>.Success(new StoreToken(token, id.Value, LoginAnswers.Str(r, "store_name")), 200);
        }
        catch (JsonException)
        {
            return ApiResult<StoreToken>.Failure(status, "Unexpected answer opening the store.");
        }
    }

    public async Task<ApiResult<SessionInfo>> SessionStatusAsync(string accessToken, CancellationToken ct)
    {
        var (status, text, error) = await SendAsync(HttpMethod.Get, ServerContract.SessionStatusPath, accessToken, null, ct).ConfigureAwait(false);
        if (error is not null) return ApiResult<SessionInfo>.Failure(status, error);
        if (status != 200) return ApiResult<SessionInfo>.Failure(status, Refusal(status!.Value, text, "read the store"));
        try
        {
            using var doc = JsonDocument.Parse(text);
            var r = doc.RootElement;
            var perms = r.TryGetProperty("permissions", out var p) && p.ValueKind == JsonValueKind.Array
                ? p.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList()
                : null;
            if (perms is null) return ApiResult<SessionInfo>.Failure(status, "Unexpected answer reading the store.");
            return ApiResult<SessionInfo>.Success(new SessionInfo(LoginAnswers.Str(r, "store_name"), perms), 200);
        }
        catch (JsonException)
        {
            return ApiResult<SessionInfo>.Failure(status, "Unexpected answer reading the store.");
        }
    }

    public async Task<ApiResult<IssuedKey>> IssueAgentKeyAsync(string accessToken, string label, CancellationToken ct)
    {
        if (label.Length > ServerContract.MaxKeyLabelLength) label = label[..ServerContract.MaxKeyLabelLength];
        var (status, text, error) = await SendAsync(HttpMethod.Post, ServerContract.AgentKeysPath, accessToken,
            w => w.WriteString("label", label), ct).ConfigureAwait(false);
        if (error is not null) return ApiResult<IssuedKey>.Failure(status, error);
        if (status != 201) return ApiResult<IssuedKey>.Failure(status, Refusal(status!.Value, text, "connect this computer"));
        try
        {
            using var doc = JsonDocument.Parse(text);
            var r = doc.RootElement;
            var key = LoginAnswers.Str(r, "key");
            if (LoginAnswers.Int(r, "id") is not { } id || !AgentKeyStore.LooksLikeAgentKey(key))
            {
                return ApiResult<IssuedKey>.Failure(status, "Unexpected answer issuing the agent key.");
            }
            return ApiResult<IssuedKey>.Success(new IssuedKey(id, LoginAnswers.Str(r, "label"), key), 201);
        }
        catch (JsonException)
        {
            return ApiResult<IssuedKey>.Failure(status, "Unexpected answer issuing the agent key.");
        }
    }

    public async Task<ApiResult<string>> RevokeAgentKeyAsync(string accessToken, int keyId, CancellationToken ct)
    {
        var path = string.Format(CultureInfo.InvariantCulture, ServerContract.AgentKeyRevokePathFormat, keyId);
        var (status, text, error) = await SendAsync(HttpMethod.Post, path, accessToken, null, ct).ConfigureAwait(false);
        if (error is not null) return ApiResult<string>.Failure(status, error);
        return status == 200
            ? ApiResult<string>.Success("revoked", 200)
            : ApiResult<string>.Failure(status, Refusal(status!.Value, text, "revoke the old key"));
    }

    private async Task<(int? Status, string Text, string? Error)> SendAsync(
        HttpMethod method, string path, string accessToken, Action<Utf8JsonWriter>? body, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(method, ApiAddress.Combine(_api, path));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            if (body is not null) request.Content = Json(body);
            else if (method == HttpMethod.Post) request.Content = Json(_ => { });
            using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
            if (Http.IsRedirect(response)) return ((int)response.StatusCode, "", Http.RedirectDetail(response));
            return ((int)response.StatusCode, await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false), null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            return (null, "", "Could not reach DineroBook: " + UploadAnswers.Describe(ex));
        }
    }

    /// <summary>Why a signed-in call was refused, in words.</summary>
    internal static string Refusal(int status, string body, string action)
    {
        var detail = ErrorDetail.Text(body);
        return status switch
        {
            401 => "The sign-in ended before it finished. Sign in again.",
            402 => detail.Length > 0 ? detail : "This store's subscription has lapsed.",
            403 => detail.Length > 0 ? $"Not allowed to {action}: {detail}" : $"Not allowed to {action}.",
            404 => detail.Length > 0 ? detail : "Not found.",
            429 => "DineroBook is busy (too many requests). Wait a minute and try again.",
            >= 500 => $"DineroBook had a problem (HTTP {status}). Try again in a minute.",
            _ => $"Could not {action} (HTTP {status})" + (detail.Length > 0 ? ": " + detail : "."),
        };
    }

    private static ByteArrayContent Json(Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            write(w);
            w.WriteEndObject();
        }
        var content = new ByteArrayContent(buffer.ToArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = Encoding.UTF8.WebName };
        return content;
    }
}
