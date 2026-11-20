using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace DineroBook.Processor.Connect;

/// <summary>A key the server issued. A class: the key must never reach a
/// generated ToString.</summary>
public sealed class IssuedKey(int id, string label, string key)
{
    public int Id { get; } = id;
    public string Label { get; } = label;

    /// <summary>The raw key, shown by the server exactly once.</summary>
    public string Key { get; } = key;

    public override string ToString() => $"IssuedKey({Id}, {Label})";
}

public sealed record ConnectedStore(int StoreId, string StoreName, string ConnectedBy);

/// <summary>Where the new key goes: the Manager saves it (DPAPI) and
/// records the store in settings.json. Throws when it cannot.</summary>
public interface IKeySink
{
    void Save(IssuedKey key, ConnectedStore store);
}

public sealed record ConnectResult(bool Ok, string Message, ConnectedStore? Store)
{
    public static ConnectResult Fail(string message) => new(false, message, null);
}

/// <summary>The connect code as people and barcode scanners type it.</summary>
public static class ConnectCode
{
    /// <summary>api/Modules/PosImport/Services/pairing.py :: PAIRING_LENGTH.</summary>
    public const int Length = 12;

    /// <summary>Upper case, letters and digits only: "k7m4-q2xp 9hd3" →
    /// "K7M4Q2XP9HD3" (the server reads it the same way).</summary>
    public static string Normalize(string? typed) =>
        new((typed ?? "").Where(char.IsAsciiLetterOrDigit).Select(char.ToUpperInvariant).ToArray());

    public static bool IsComplete(string? typed) => Normalize(typed).Length == Length;
}

/// <summary>
/// "Connect" in DineroBook Manager: the person at the store scans (or
/// types) the connect code someone made on DineroBook's Register import
/// page, and <c>POST /api/v2/posimport/agent/pair</c> answers with the
/// store's agent key. Nobody types a name or a password (owner,
/// 2026-11-19). The computer's previous key, when it has one, rides along
/// in <c>X-Agent-Key</c> and the server revokes it.
/// </summary>
public sealed class ConnectClient(HttpClient http, Uri apiBase, RateWindow guard, TimeProvider? time = null)
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    /// <summary>The label the key gets on the store's Register import page.</summary>
    public static string KeyLabel(string computerName)
    {
        var label = $"{computerName} – DineroBook Processor";
        return label.Length <= ServerContract.MaxKeyLabelLength ? label : label[..ServerContract.MaxKeyLabelLength];
    }

    /// <summary>Trades the code for the key and hands it to
    /// <paramref name="sink"/>. Never throws for an answer the server can
    /// give.</summary>
    public async Task<ConnectResult> ConnectAsync(string typedCode, string label, string? previousKey, IKeySink sink, CancellationToken ct)
    {
        var code = ConnectCode.Normalize(typedCode);
        if (code.Length != ConnectCode.Length)
        {
            return ConnectResult.Fail($"A connect code has {ConnectCode.Length} letters and numbers. Scan the barcode again, or type the code as DineroBook shows it.");
        }
        var now = _time.GetUtcNow();
        if (guard.WaitBeforeNext(now) > TimeSpan.Zero)
        {
            return ConnectResult.Fail("Too many tries. Wait a minute and try again.");
        }
        guard.Record(now);

        int status;
        string text;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, ApiAddress.Combine(apiBase, ServerContract.PairPath));
            if (AgentKeyStore.LooksLikeAgentKey(previousKey))
            {
                request.Headers.TryAddWithoutValidation(ServerContract.AgentKeyHeader, previousKey);
            }
            request.Content = Body(code, label.Length <= ServerContract.MaxKeyLabelLength ? label : label[..ServerContract.MaxKeyLabelLength]);
            using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
            if (Http.IsRedirect(response)) return ConnectResult.Fail(Http.RedirectDetail(response));
            status = (int)response.StatusCode;
            text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
        {
            return ConnectResult.Fail("Could not reach DineroBook: " + UploadAnswers.Describe(ex));
        }

        if (status != 200) return ConnectResult.Fail(Refusal(status, text));
        if (Parse(text) is not { } answer) return ConnectResult.Fail("Unexpected answer from DineroBook. Try again, or update DineroBook Manager.");
        try
        {
            sink.Save(answer.Key, answer.Store);
        }
        catch (Exception ex)
        {
            return ConnectResult.Fail("The key could not be saved on this computer: " + ex.Message +
                                      " Revoke it in DineroBook (Register import → Automatic uploads) and connect again.");
        }
        return new ConnectResult(true, $"This computer now sends {answer.Store.StoreName}'s register files.", answer.Store);
    }

    /// <summary>The 200 answer (AgentPairResponse), or null when it is not one.</summary>
    internal static (IssuedKey Key, ConnectedStore Store)? Parse(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return null;
            var key = Str(r, "key");
            if (Int(r, "id") is not { } id || Int(r, "store_id") is not { } storeId || !AgentKeyStore.LooksLikeAgentKey(key))
            {
                return null;
            }
            var name = Str(r, "store_name");
            return (new IssuedKey(id, Str(r, "label"), key),
                new ConnectedStore(storeId, name.Length > 0 ? name : $"Store {storeId}", Str(r, "connected_by")));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Why the code was refused, in words.</summary>
    internal static string Refusal(int status, string body)
    {
        var detail = ErrorDetail.Text(body);
        return status switch
        {
            401 => detail.Length > 0 ? detail : "This connect code does not work. Make a new one in DineroBook.",
            402 or 403 => detail.Length > 0 ? detail : "DineroBook is not taking uploads for this store.",
            422 => "DineroBook refused the request; this DineroBook Manager needs an update.",
            429 => "Too many tries from this network. Wait a minute and try again.",
            >= 500 => $"DineroBook had a problem (HTTP {status}). Try again in a minute.",
            _ => $"Could not connect (HTTP {status})" + (detail.Length > 0 ? ": " + detail : "."),
        };
    }

    private static ByteArrayContent Body(string code, string label)
    {
        using var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer))
        {
            w.WriteStartObject();
            w.WriteString("code", code);
            w.WriteString("label", label);
            w.WriteEndObject();
        }
        var content = new ByteArrayContent(buffer.ToArray());
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = Encoding.UTF8.WebName };
        return content;
    }

    private static string Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static int? Int(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
}
