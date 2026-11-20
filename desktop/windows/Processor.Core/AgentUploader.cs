using System.Net;
using System.Reflection;
using System.Text.Json;

namespace DineroBook.Processor;

/// <summary>The HTTP client both programs use: no cookies kept, redirects
/// not followed (a redirect is reported, never silently followed to another
/// address), the computer's proxy settings, normal certificate checks.</summary>
public static class Http
{
    public static HttpClient Create(string userAgent, TimeSpan timeout, HttpMessageHandler? handler = null)
    {
        handler ??= new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectTimeout = TimeSpan.FromSeconds(20),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        };
        var client = new HttpClient(handler, disposeHandler: true) { Timeout = timeout };
        client.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        return client;
    }

    /// <summary>"name/1.2.3" from the running program's version.</summary>
    public static string UserAgent(string product, Assembly? assembly = null)
    {
        var v = (assembly ?? Assembly.GetEntryAssembly())?.GetName().Version ?? new Version(0, 0, 0);
        return $"{product}/{v.ToString(3)}";
    }

    /// <summary>A redirect means the address is not the API itself.</summary>
    internal static string RedirectDetail(HttpResponseMessage resp) =>
        $"HTTP {(int)resp.StatusCode}: the server sent us to {resp.Headers.Location?.ToString() ?? "another address"}; check the DineroBook address in settings";

    internal static bool IsRedirect(HttpResponseMessage resp) => (int)resp.StatusCode is >= 300 and < 400;
}

public interface IAgentUploader
{
    Task<UploadResult> UploadAsync(string fileName, byte[] content, CancellationToken ct);
}

/// <summary>
/// <c>POST {api}/api/v2/posimport/agent/upload</c> with
/// <c>{filename, content_base64}</c> and the store's key in
/// <c>X-Agent-Key</c>. The key never goes in a log line or an error message.
/// </summary>
public sealed class AgentUploader : IAgentUploader
{
    private readonly HttpClient _http;
    private readonly Uri _endpoint;
    private readonly string _key;

    public AgentUploader(HttpClient http, Uri apiBase, string agentKey)
    {
        _http = http;
        _endpoint = ApiAddress.Combine(apiBase, ServerContract.UploadPath);
        _key = agentKey;
    }

    public async Task<UploadResult> UploadAsync(string fileName, byte[] content, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint);
        request.Headers.TryAddWithoutValidation(ServerContract.AgentKeyHeader, _key);
        request.Content = new ByteArrayContent(UploadBody(fileName, Convert.ToBase64String(content)));
        request.Content.Headers.ContentType = new("application/json") { CharSet = "utf-8" };
        return await SendAsync(_http, request, ct).ConfigureAwait(false);
    }

    /// <summary>The upload body, exactly the two fields the server allows
    /// (AgentUploadRequest forbids any other).</summary>
    internal static byte[] UploadBody(string fileName, string contentBase64)
    {
        using var buffer = new MemoryStream(contentBase64.Length + fileName.Length + 64);
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteString("filename", fileName);
            w.WriteString("content_base64", contentBase64);
            w.WriteEndObject();
        }
        return buffer.ToArray();
    }

    internal static async Task<UploadResult> SendAsync(HttpClient http, HttpRequestMessage request, CancellationToken ct)
    {
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct).ConfigureAwait(false);
            if (Http.IsRedirect(response))
            {
                return new UploadResult(UploadVerdict.TryAgain, (int)response.StatusCode, Http.RedirectDetail(response));
            }
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return UploadAnswers.FromResponse((int)response.StatusCode, body);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            // TaskCanceledException without our token = the request timed out.
            return UploadAnswers.FromException(ex);
        }
    }
}

/// <summary>"Test connection": is DineroBook reachable, and does the saved
/// key still work?</summary>
public static class ConnectionCheck
{
    public sealed record Result(bool Ok, string Message);

    /// <summary>GET /api/v2/health (public).</summary>
    public static async Task<Result> ReachableAsync(HttpClient http, Uri apiBase, CancellationToken ct)
    {
        try
        {
            using var response = await http.GetAsync(ApiAddress.Combine(apiBase, ServerContract.HealthPath), ct).ConfigureAwait(false);
            if (Http.IsRedirect(response)) return new Result(false, Http.RedirectDetail(response));
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if ((int)response.StatusCode != 200) return new Result(false, $"DineroBook answered HTTP {(int)response.StatusCode}.");
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("status", out var s) && s.GetString() == "ok")
                {
                    return new Result(true, $"DineroBook is reachable at {apiBase.Host}.");
                }
            }
            catch (JsonException)
            {
            }
            return new Result(false, "Something answered at that address, but it is not DineroBook.");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            return new Result(false, "Could not reach DineroBook: " + UploadAnswers.Describe(ex));
        }
    }

    /// <summary>
    /// Checks the key without sending a file: an upload whose content is not
    /// base64. The server checks the key first (401 when refused), then
    /// refuses the content with <see cref="ServerContract.NotBase64Detail"/>
    /// before storing anything. The contract test on the server pins that
    /// order.
    /// </summary>
    public static async Task<Result> KeyAsync(HttpClient http, Uri apiBase, string agentKey, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, ApiAddress.Combine(apiBase, ServerContract.UploadPath));
        request.Headers.TryAddWithoutValidation(ServerContract.AgentKeyHeader, agentKey);
        request.Content = new ByteArrayContent(AgentUploader.UploadBody("dinerobook-processor-connection-test.xml", "!"));
        request.Content.Headers.ContentType = new("application/json") { CharSet = "utf-8" };
        var r = await AgentUploader.SendAsync(http, request, ct).ConfigureAwait(false);
        return r.Verdict switch
        {
            UploadVerdict.RejectedForGood when r.Detail == ServerContract.NotBase64Detail =>
                new Result(true, "The agent key works."),
            UploadVerdict.KeyRejected =>
                new Result(false, "The agent key was refused. Choose Connect again to get a new one."),
            UploadVerdict.StoreClosed => new Result(false, r.Detail),
            UploadVerdict.RateLimited => new Result(false, "DineroBook is busy (too many uploads). Try again in a minute."),
            _ => new Result(false, "Unexpected answer from DineroBook: " + r.Detail),
        };
    }
}
