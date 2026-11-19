using System.Net;
using System.Text;
using DineroBook.Processor;
using Microsoft.Extensions.Logging;

namespace Processor.Tests;

/// <summary>A clock the test moves by hand.</summary>
internal sealed class ManualClock : TimeProvider
{
    private DateTimeOffset _now;

    public ManualClock(DateTimeOffset start, TimeZoneInfo? zone = null)
    {
        _now = start;
        LocalTimeZone = zone ?? TimeZoneInfo.Utc;
    }

    public override DateTimeOffset GetUtcNow() => _now;

    public override TimeZoneInfo LocalTimeZone { get; }

    public void Advance(TimeSpan by) => _now += by;

    /// <summary>A delay that just moves the clock.</summary>
    public Task Delay(TimeSpan by, CancellationToken _)
    {
        Advance(by);
        return Task.CompletedTask;
    }
}

/// <summary>A temporary folder deleted at the end of the test.</summary>
internal sealed class TempDir : IDisposable
{
    public TempDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "dbproc-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }

    public string File(string name) => System.IO.Path.Combine(Path, name);

    public void Dispose()
    {
        try { Directory.Delete(Path, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

/// <summary>Captures log lines.</summary>
internal sealed class ListLogger : ILogger
{
    public List<(LogLevel Level, string Message)> Lines { get; } = new();

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter) => Lines.Add((logLevel, formatter(state, exception)));

    public string All => string.Join("\n", Lines.Select(l => $"{l.Level}: {l.Message}"));
}

/// <summary>An HTTP handler answering from a function, recording each
/// request (with its body read out).</summary>
internal sealed class FakeHandler(Func<HttpRequestMessage, string, HttpResponseMessage> answer) : HttpMessageHandler
{
    public List<(HttpRequestMessage Request, string Body)> Requests { get; } = new();

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        Requests.Add((request, body));
        return answer(request, body);
    }

    public static HttpResponseMessage Json(int status, string json) => new((HttpStatusCode)status)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json"),
    };
}
