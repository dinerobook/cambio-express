using System.Text.Json;
using System.Text.Json.Nodes;

namespace DineroBook.CheckDesk;

/// <summary>
/// The page's scanner messages (api/Modules/CheckCashing/INVARIANTS.md
/// "Scanner"). The page posts <c>{"type":"scanner.status","id":n}</c>,
/// <c>{"type":"scanner.scan","id":n}</c> or
/// <c>{"type":"scanner.cancel"}</c>; every request with an id gets one
/// <c>{"type":"scanner.reply","id":n,"ok":…}</c> back. One scan at a
/// time: a second one while the first waits is refused as busy, and
/// cancel ends the waiting one with no_check.
/// </summary>
public sealed class ScannerBridge
{
    private readonly IScanner _scanner;
    private readonly object _lock = new();
    private CancellationTokenSource? _scan;

    public ScannerBridge(IScanner scanner)
    {
        _scanner = scanner;
    }

    /// <summary>Answer one message from the page; null when it needs no
    /// answer (cancel, or something that is not a scanner message).</summary>
    public async Task<string?> HandleAsync(string message)
    {
        JsonObject? request;
        try
        {
            request = JsonNode.Parse(message) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
        if (request is null) return null;
        var type = request["type"] is JsonValue t && t.TryGetValue<string>(out var name) ? name : null;
        var id = request["id"] is JsonValue v && v.TryGetValue<long>(out var n) ? n : (long?)null;

        switch (type)
        {
            case "scanner.cancel":
                lock (_lock) _scan?.Cancel();
                return null;
            case "scanner.status" when id is not null:
                return await StatusAsync(id.Value);
            case "scanner.scan" when id is not null:
                return await ScanAsync(id.Value);
            default:
                return null;
        }
    }

    private async Task<string> StatusAsync(long id)
    {
        bool ready;
        try
        {
            ready = await _scanner.IsReadyAsync();
        }
        catch (Exception)
        {
            ready = false;
        }
        return Reply(id, new JsonObject
        {
            ["ok"] = true,
            ["status"] = ready ? "ready" : ScanErrors.NotConnected,
        });
    }

    private async Task<string> ScanAsync(long id)
    {
        CancellationTokenSource mine;
        lock (_lock)
        {
            if (_scan is not null) return Error(id, ScanErrors.Busy);
            mine = _scan = new CancellationTokenSource();
        }
        try
        {
            var scan = _scanner.ScanAsync(mine.Token);
            // Cancel answers at once; a scan already inside the scanner
            // finishes on its own and its result is dropped.
            var stopped = Task.Delay(Timeout.Infinite, mine.Token);
            var done = await Task.WhenAny(scan, stopped);
            if (done != scan) return Error(id, ScanErrors.NoCheck);
            var r = await scan;
            return Reply(id, new JsonObject
            {
                ["ok"] = true,
                ["micr"] = new JsonObject
                {
                    ["raw"] = r.Raw,
                    ["routing"] = r.Routing,
                    ["account"] = r.Account,
                    ["number"] = r.Number,
                    ["amount_cents"] = r.AmountCents,
                },
                ["front"] = r.Front is null ? null : Convert.ToBase64String(r.Front),
                ["back"] = r.Back is null ? null : Convert.ToBase64String(r.Back),
            });
        }
        catch (ScannerException e)
        {
            return Error(id, e.Code);
        }
        catch (OperationCanceledException)
        {
            return Error(id, ScanErrors.NoCheck);
        }
        catch (Exception)
        {
            return Error(id, ScanErrors.Failed);
        }
        finally
        {
            lock (_lock)
            {
                if (_scan == mine) _scan = null;
            }
            mine.Dispose();
        }
    }

    private static string Error(long id, string code) =>
        Reply(id, new JsonObject { ["ok"] = false, ["error"] = code });

    private static string Reply(long id, JsonObject body)
    {
        var reply = new JsonObject { ["type"] = "scanner.reply", ["id"] = id };
        foreach (var (key, value) in body.ToList())
        {
            body.Remove(key);
            reply[key] = value;
        }
        return reply.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
    }
}
