using System.Text.Json;

namespace DineroBook.Processor;

/// <summary>What to do with a file after the server answered.</summary>
public enum UploadVerdict
{
    /// <summary>200 with the upload answer: staged, duplicate or staged with
    /// a parse error. Goes in the ledger.</summary>
    Accepted,

    /// <summary>422 with a message: the server will never take this file
    /// (too large, no name). Recorded as skipped, never sent again.</summary>
    RejectedForGood,

    /// <summary>401: the agent key was refused (revoked, or another
    /// store's). Stop sending until someone signs in again.</summary>
    KeyRejected,

    /// <summary>402 / 403: the store is closed to writes (subscription
    /// lapsed, frozen, disabled). Stop sending, try again later.</summary>
    StoreClosed,

    /// <summary>422 from the request check itself: the server no longer
    /// accepts the upload as this version sends it. Never skip files over
    /// it — stop and say "update the Processor".</summary>
    ContractMismatch,

    /// <summary>429: too many requests. Pause, then carry on.</summary>
    RateLimited,

    /// <summary>Anything else (5xx, network, an unexpected answer): try the
    /// same file again later. Never dropped.</summary>
    TryAgain,
}

/// <summary>The server's answer to an accepted upload
/// (AgentUploadResponse).</summary>
public sealed record AcceptedFile(bool Staged, bool Duplicate, string? BusinessDate, string ParseError)
{
    /// <summary>staged, duplicate or parse_error — for the log and the ledger.</summary>
    public string Outcome => Duplicate ? "duplicate" : ParseError.Length > 0 ? "parse_error" : "staged";
}

public sealed record UploadResult(UploadVerdict Verdict, int? Status, string Detail, AcceptedFile? Accepted = null);

/// <summary>
/// Turns the upload route's answer into a verdict. Mirrors the Python agent:
/// 200 done, 401 key refused, 422 skip for good, everything else try again;
/// plus 402 / 403 (a closed store, once the server refuses those) and a 422
/// from the request check, which means this version is out of date.
/// </summary>
public static class UploadAnswers
{
    public static UploadResult FromResponse(int status, string? body)
    {
        switch (status)
        {
            case 200:
                var accepted = ParseAccepted(body);
                return accepted is null
                    ? new UploadResult(UploadVerdict.TryAgain, status, "The server's answer was not an upload answer.")
                    : new UploadResult(UploadVerdict.Accepted, status, accepted.Outcome, accepted);
            case 401:
                return new UploadResult(UploadVerdict.KeyRejected, status, "The agent key was refused.");
            case 402:
            case 403:
                var why = ErrorDetail.Text(body);
                return new UploadResult(UploadVerdict.StoreClosed, status,
                    why.Length > 0 ? why : $"The server refused uploads (HTTP {status}).");
            case 422:
                // The route's own refusals carry a sentence; FastAPI's request
                // check carries a list of field errors.
                if (ErrorDetail.IsSentence(body, out var sentence))
                {
                    return new UploadResult(UploadVerdict.RejectedForGood, status, sentence);
                }
                return new UploadResult(UploadVerdict.ContractMismatch, status,
                    "The server refused the upload format: " + ErrorDetail.Text(body));
            case 429:
                return new UploadResult(UploadVerdict.RateLimited, status, "Too many uploads; pausing.");
            default:
                var detail = ErrorDetail.Text(body);
                return new UploadResult(UploadVerdict.TryAgain, status,
                    $"HTTP {status}" + (detail.Length > 0 ? ": " + detail : ""));
        }
    }

    public static UploadResult FromException(Exception ex) =>
        new(UploadVerdict.TryAgain, null, Describe(ex));

    internal static string Describe(Exception ex)
    {
        var inner = ex;
        while (inner.InnerException is not null) inner = inner.InnerException;
        // HttpClient often repeats the socket's message in its own.
        return ReferenceEquals(inner, ex) || ex.Message.Contains(inner.Message, StringComparison.Ordinal)
            ? ex.Message
            : ex.Message + " (" + inner.Message + ")";
    }

    internal static AcceptedFile? ParseAccepted(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            // A captive portal or proxy page can answer 200 too: only the
            // real answer (both flags present) counts as sent.
            if (!root.TryGetProperty("staged", out var staged) || staged.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
            if (!root.TryGetProperty("duplicate", out var dup) || dup.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
            string? day = root.TryGetProperty("business_date", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
            var parseError = root.TryGetProperty("parse_error", out var pe) && pe.ValueKind == JsonValueKind.String ? pe.GetString() ?? "" : "";
            return new AcceptedFile(staged.GetBoolean(), dup.GetBoolean(), day, parseError);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>The <c>detail</c> of a FastAPI error answer.</summary>
public static class ErrorDetail
{
    /// <summary>The message as text: a string detail, an object's
    /// <c>message</c>, or the first field error's <c>msg</c>.</summary>
    public static string Text(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return "";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("detail", out var detail))
            {
                return "";
            }
            switch (detail.ValueKind)
            {
                case JsonValueKind.String:
                    return detail.GetString() ?? "";
                case JsonValueKind.Object:
                    return detail.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String
                        ? m.GetString() ?? "" : "";
                case JsonValueKind.Array:
                    foreach (var item in detail.EnumerateArray())
                    {
                        if (item.ValueKind == JsonValueKind.Object
                            && item.TryGetProperty("msg", out var msg) && msg.ValueKind == JsonValueKind.String)
                        {
                            var loc = item.TryGetProperty("loc", out var l) && l.ValueKind == JsonValueKind.Array
                                ? string.Join(".", l.EnumerateArray().Select(x => x.ToString())) + ": " : "";
                            return loc + msg.GetString();
                        }
                    }
                    return "";
                default:
                    return "";
            }
        }
        catch (JsonException)
        {
            return "";
        }
    }

    /// <summary>True when <c>detail</c> is a plain string (a route's own
    /// HTTPException), not a list of field errors.</summary>
    public static bool IsSentence(string? body, out string sentence)
    {
        sentence = "";
        if (string.IsNullOrWhiteSpace(body)) return false;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("detail", out var detail)
                && detail.ValueKind == JsonValueKind.String)
            {
                sentence = detail.GetString() ?? "";
                return true;
            }
        }
        catch (JsonException)
        {
        }
        return false;
    }
}
