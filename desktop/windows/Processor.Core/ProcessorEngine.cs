using System.Globalization;
using Microsoft.Extensions.Logging;

namespace DineroBook.Processor;

/// <summary>
/// One pass of the Processor: read the settings, list Passport's folder, send
/// the files that are ready, write status.json. The service calls
/// <see cref="RunCycleAsync"/> in a loop and waits the time it returns.
/// <para>
/// The rules it keeps:
/// <list type="bullet">
/// <item>read only — Passport's files are never moved, renamed, deleted or
/// locked;</item>
/// <item>a file goes up once its size and time held still across two
/// polls;</item>
/// <item>strictly oldest first (by write time): a file that fails is tried
/// again before anything newer, and no file goes ahead of an older one that
/// is still settling. The server books a business day as soon as a file
/// from a later day arrives, so a day's files must all be up before the
/// next day's;</item>
/// <item>nothing is ever dropped: every answer but "accepted" and "refused
/// for good (422)" leaves the file to be tried again;</item>
/// <item>under the server's rate limit (<see cref="UploadPacer"/>).</item>
/// </list>
/// </para>
/// </summary>
public sealed class ProcessorEngine
{
    /// <summary>With many files ready, the folder is listed again only this
    /// often (listing 100,000 files on a network share every 5 seconds is
    /// wasted work while a backlog drains).</summary>
    public static readonly TimeSpan BacklogSweepEvery = TimeSpan.FromMinutes(1);
    public const int BacklogThreshold = 50;

    /// <summary>When the engine cannot run (no key, bad settings) or is
    /// paused, it still looks again this often, so a new key or new settings
    /// take effect quickly.</summary>
    public static readonly TimeSpan RecheckEvery = TimeSpan.FromSeconds(10);

    private static readonly TimeSpan StatusEvery = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ProgressEvery = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan RepeatProblemLogEvery = TimeSpan.FromMinutes(30);

    private readonly DataPaths _paths;
    private readonly IConfigSource _config;
    private readonly IPassportFolder _folder;
    private readonly Func<Uri, string, IAgentUploader> _uploaderFor;
    private readonly TimeProvider _time;
    private readonly ILogger _log;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Action<ProcessorStatus> _writeStatus;

    private readonly StabilityTracker _tracker = new();
    private readonly UploadPacer _pacer = new();
    private readonly ProcessorStatus _status;

    private FileLedger? _sent;
    private FileLedger? _skipped;
    private EngineConfig? _cfg;
    private IAgentUploader? _uploader;
    private FilePatterns _patterns = new(ProcessorSettings.DefaultPatterns);
    private string _watchFolder = "";

    private DateTimeOffset _pausedUntil;
    private int _consecutiveFailures;
    private string _failingFile = "";
    private int _failingFileCount;

    private DateOnly _today;
    private int _todayCount;
    private DateTimeOffset _lastStatusWrite;
    private DateTimeOffset _lastProgressLog;
    private int _sentSinceProgress;
    private (string State, string Message, DateTimeOffset At)? _lastLoggedProblem;
    private bool _statusWriteFailed;

    private enum Step { Done, NotReady, Pause }

    public ProcessorEngine(
        DataPaths paths,
        IConfigSource config,
        IPassportFolder folder,
        Func<Uri, string, IAgentUploader> uploaderFor,
        TimeProvider time,
        ILogger log,
        string version,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Action<ProcessorStatus>? writeStatus = null)
    {
        _paths = paths;
        _config = config;
        _folder = folder;
        _uploaderFor = uploaderFor;
        _time = time;
        _log = log;
        _delay = delay ?? ((d, ct) => Task.Delay(d, time, ct));
        _writeStatus = writeStatus ?? (s => s.Write(paths.Status));
        _status = new ProcessorStatus { Version = version, Running = true, StartedAt = time.GetUtcNow() };
    }

    /// <summary>The status as last written (for tests and the console).</summary>
    public ProcessorStatus Status => _status;

    private DateTimeOffset Now => _time.GetUtcNow();

    public async Task<TimeSpan> RunCycleAsync(CancellationToken ct)
    {
        var cycleStart = Now;
        if (!OpenLedgers())
        {
            FlushStatus(force: true);
            return RecheckEvery;
        }

        var cfg = _config.Current(out var changed);
        if (changed || _cfg is null) Apply(cfg);
        var poll = TimeSpan.FromSeconds(cfg.Settings.EffectivePollSeconds);

        if (!cfg.CanRun)
        {
            Problem(cfg.State, cfg.Problem,
                cfg.State == ProcessorState.NotSignedIn ? LogLevel.Warning : LogLevel.Error);
            FlushStatus(force: true);
            return RecheckEvery;
        }

        if (_pausedUntil > cycleStart)
        {
            _status.NextTryAt = _pausedUntil;
            FlushStatus(force: true);
            return Min(_pausedUntil - cycleStart, RecheckEvery);
        }

        // ── Sweep ──
        List<FileSnapshot> pending;
        try
        {
            pending = _folder.List(_watchFolder)
                .Where(f => _patterns.Matches(f.Name) && !_sent!.Contains(f.Name) && !_skipped!.Contains(f.Name))
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                       or System.Security.SecurityException or ArgumentException)
        {
            Problem(ProcessorState.FolderUnavailable,
                $"Cannot open the Passport folder {_watchFolder}: {ex.Message}", LogLevel.Error);
            _tracker.Reset();
            FlushStatus(force: true);
            return poll;
        }
        if (_status.State == ProcessorState.FolderUnavailable)
        {
            ClearProblem($"The Passport folder {_watchFolder} can be read again.");
        }

        var stable = _tracker.Observe(pending)
            .Select(f => f.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        // Oldest first, and only up to the first file that is not ready:
        // a newer file never goes ahead of an older one still settling.
        // (An empty file can never be sent, so it holds nothing back.)
        var ready = pending
            .Where(f => f.Length > 0)
            .OrderBy(f => f.LastWriteUtc)
            .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
            .TakeWhile(f => stable.Contains(f.Name))
            .ToList();
        _status.Waiting = pending.Count(f => f.Length > 0);

        if (ready.Count == 0)
        {
            SettleState();
            FlushStatus(force: true);
            return poll;
        }

        // ── Send, oldest first, until it is time to list the folder again ──
        var sweepEvery = ready.Count > BacklogThreshold ? Max(poll, BacklogSweepEvery) : poll;
        var deadline = cycleStart + sweepEvery;
        SetState(ProcessorState.Sending, $"Sending {_status.Waiting:N0} file(s).");
        foreach (var file in ready)
        {
            ct.ThrowIfCancellationRequested();
            var now = Now;
            if (now >= deadline)
            {
                FlushStatus(force: true);
                return TimeSpan.Zero;
            }
            var wait = _pacer.WaitBeforeNext(now);
            if (wait > TimeSpan.Zero)
            {
                if (now + wait >= deadline)
                {
                    FlushStatus(force: true);
                    return wait;
                }
                await _delay(wait, ct).ConfigureAwait(false);
            }
            switch (await SendAsync(file, ct).ConfigureAwait(false))
            {
                case Step.Pause:
                    FlushStatus(force: true);
                    return Min(_pausedUntil - Now, RecheckEvery);
                case Step.NotReady:
                    // Changed since the listing: it waits for two more
                    // polls, and nothing newer may go ahead of it.
                    FlushStatus(force: true);
                    return poll;
                default:
                    _status.Waiting = Math.Max(0, _status.Waiting - 1);
                    LogProgress();
                    FlushStatus(force: false);
                    break;
            }
        }

        SettleState();
        FlushStatus(force: true);
        return poll;
    }

    /// <summary>Marks the status stopped (service shutting down).</summary>
    public void Stopped()
    {
        _status.Running = false;
        SetState(ProcessorState.Stopped, "The service is stopped.");
        _status.NextTryAt = null;
        FlushStatus(force: true);
    }

    // ── One file ──

    private async Task<Step> SendAsync(FileSnapshot file, CancellationToken ct)
    {
        if (file.Name.Length > ServerContract.MaxFilenameLength)
        {
            Skip(file, "name_too_long",
                $"the name is longer than the {ServerContract.MaxFilenameLength} characters the server takes");
            return Step.Done;
        }
        if (file.Length > ServerContract.MaxFileBytes)
        {
            Skip(file, "too_large", $"{file.Length:N0} bytes; the server takes up to {ServerContract.MaxFileBytes:N0}");
            return Step.Done;
        }

        byte[]? content;
        try
        {
            content = _folder.Read(file);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            _log.LogInformation("{File} was removed from the folder before it could be sent.", file.Name);
            _tracker.Forget(file.Name);
            return Step.Done;
        }
        catch (UnauthorizedAccessException ex)
        {
            return Failed(file, "cannot read the file: " + ex.Message);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            // Passport has it open without sharing: still being written.
            _tracker.Forget(file.Name);
            return Step.NotReady;
        }
        catch (IOException ex)
        {
            return Failed(file, "cannot read the file: " + ex.Message);
        }
        if (content is null)
        {
            _tracker.Forget(file.Name);
            return Step.NotReady;
        }

        _pacer.Record(Now);
        var result = await _uploader!.UploadAsync(file.Name, content, ct).ConfigureAwait(false);
        switch (result.Verdict)
        {
            case UploadVerdict.Accepted:
                Accepted(file, result.Accepted!);
                return Step.Done;
            case UploadVerdict.RejectedForGood:
                Skip(file, "rejected", $"HTTP {result.Status}: {result.Detail}");
                ResetFailures();
                return Step.Done;
            case UploadVerdict.KeyRejected:
                Pause(RetryPolicy.BlockedPause, ProcessorState.KeyRejected,
                    "DineroBook refused the agent key. Open DineroBook Manager and choose Sign in again.");
                return Step.Pause;
            case UploadVerdict.StoreClosed:
                Pause(RetryPolicy.BlockedPause, ProcessorState.StoreClosed,
                    "DineroBook is not taking uploads for this store: " + result.Detail);
                return Step.Pause;
            case UploadVerdict.ContractMismatch:
                Pause(RetryPolicy.BlockedPause, ProcessorState.UpdateNeeded,
                    "DineroBook refused the upload format; this DineroBook Processor needs an update. " + result.Detail);
                return Step.Pause;
            case UploadVerdict.RateLimited:
                Pause(RetryPolicy.RateLimitedPause, ProcessorState.RetryLater,
                    "DineroBook asked us to slow down (too many uploads). Carrying on in a minute.", LogLevel.Warning);
                return Step.Pause;
            default:
                return Failed(file, result.Detail);
        }
    }

    private void Accepted(FileSnapshot file, AcceptedFile answer)
    {
        var at = Now;
        try
        {
            _sent!.Add(file.Name, at, answer.Outcome);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Still remembered for this run; after a restart the server
            // would answer "duplicate".
            _log.LogError("Could not write {Ledger}: {Error}", _paths.SentLedger, ex.Message);
        }
        _tracker.Forget(file.Name);
        ResetFailures();

        var today = Today(at);
        if (today != _today)
        {
            _today = today;
            _todayCount = 0;
        }
        _todayCount++;
        _sentSinceProgress++;
        _status.TodayCount = _todayCount;
        _status.TodayDate = _today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        _status.SentTotal = _sent!.Count;
        _status.LastUploadAt = at;
        _status.LastUploadFile = file.Name;
        _status.LastUploadResult = answer.Outcome;
        if (_lastLoggedProblem is not null)
        {
            _log.LogInformation("Uploads are going through again.");
            _lastLoggedProblem = null;
        }
        SetState(ProcessorState.Sending, $"Sending {_status.Waiting:N0} file(s).");

        switch (answer.Outcome)
        {
            case "duplicate":
                _log.LogInformation("{File}: already on the server (duplicate).", file.Name);
                break;
            case "parse_error":
                _log.LogWarning("{File}: sent; the server could not read it (parse_error: {Error}).",
                    file.Name, answer.ParseError);
                break;
            default:
                _log.LogInformation("{File}: staged (business day {Day}).", file.Name, answer.BusinessDate ?? "unknown");
                break;
        }
    }

    private void Skip(FileSnapshot file, string outcome, string why)
    {
        try
        {
            _skipped!.Add(file.Name, Now, outcome + ": " + why);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogError("Could not write {Ledger}: {Error}", _paths.SkippedLedger, ex.Message);
        }
        _tracker.Forget(file.Name);
        _status.SkippedTotal = _skipped!.Count;
        _log.LogWarning("{File}: not sent, and will not be tried again ({Why}).", file.Name, why);
    }

    /// <summary>A try that did not work (5xx, network, odd answer). The file
    /// stays first in line and is tried again after the next step of the
    /// ladder.</summary>
    private Step Failed(FileSnapshot file, string detail)
    {
        _consecutiveFailures++;
        if (string.Equals(_failingFile, file.Name, StringComparison.OrdinalIgnoreCase))
        {
            _failingFileCount++;
        }
        else
        {
            _failingFile = file.Name;
            _failingFileCount = 1;
        }
        var pause = RetryPolicy.AfterFailures(_consecutiveFailures);
        var stuck = _failingFileCount >= RetryPolicy.StuckAfter;
        Pause(pause, ProcessorState.RetryLater,
            (stuck ? $"Stuck on {file.Name} ({_failingFileCount} tries): " : $"Could not send {file.Name}: ")
            + detail + $". Trying again in {Describe(pause)}; newer files wait behind it.",
            stuck ? LogLevel.Error : LogLevel.Warning);
        return Step.Pause;
    }

    private void ResetFailures()
    {
        _consecutiveFailures = 0;
        _failingFile = "";
        _failingFileCount = 0;
    }

    // ── State, status, logging ──

    private bool OpenLedgers()
    {
        if (_sent is not null && _skipped is not null) return true;
        try
        {
            Directory.CreateDirectory(_paths.State);
            var zone = _time.LocalTimeZone;
            _sent = FileLedger.Open(_paths.SentLedger, zone);
            _skipped = FileLedger.Open(_paths.SkippedLedger, zone);
            _today = Today(Now);
            _todayCount = _sent.CountOn(_today);
            _status.TodayCount = _todayCount;
            _status.TodayDate = _today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            _status.SentTotal = _sent.Count;
            _status.SkippedTotal = _skipped.Count;
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _sent = null;
            _skipped = null;
            Problem(ProcessorState.SettingsInvalid,
                $"Cannot use the data folder {_paths.State}: {ex.Message}. Open DineroBook Manager and choose Install / Update.",
                LogLevel.Error);
            return false;
        }
    }

    private void Apply(EngineConfig cfg)
    {
        var keyChanged = _cfg is null || _cfg.AgentKey != cfg.AgentKey || _cfg.ApiBase != cfg.ApiBase;
        var folderChanged = !string.Equals(_cfg?.Settings.WatchFolder, cfg.Settings.WatchFolder,
            StringComparison.OrdinalIgnoreCase);
        _cfg = cfg;
        _patterns = new FilePatterns(cfg.Settings.EffectivePatterns);
        _watchFolder = cfg.Settings.WatchFolder;
        _status.ApiUrl = cfg.ApiBase?.ToString().TrimEnd('/') ?? cfg.Settings.ApiUrl;
        _status.WatchFolder = cfg.Settings.WatchFolder;
        _status.StoreName = cfg.Settings.StoreName;
        if (cfg.Problem.Length > 0 && cfg.CanRun) _log.LogWarning("{Problem}", cfg.Problem);
        if (keyChanged)
        {
            _uploader = cfg.CanRun ? _uploaderFor(cfg.ApiBase!, cfg.AgentKey!) : null;
            // A new key (or server) means someone acted: try at once.
            _pausedUntil = DateTimeOffset.MinValue;
            ResetFailures();
            _status.NextTryAt = null;
            if (cfg.CanRun)
            {
                _log.LogInformation("Sending files from {Folder} to {Api} for {Store}.", _watchFolder, _status.ApiUrl,
                    cfg.Settings.StoreName.Length > 0 ? cfg.Settings.StoreName : "this store");
                ClearProblem("Ready to send.");
            }
        }
        if (folderChanged) _tracker.Reset();
    }

    private void Pause(TimeSpan pause, string state, string message, LogLevel level = LogLevel.Error)
    {
        _pausedUntil = Now + pause;
        _status.NextTryAt = _pausedUntil;
        Problem(state, message, level);
    }

    private void Problem(string state, string message, LogLevel level)
    {
        var now = Now;
        SetState(state, message);
        _status.LastError = message;
        _status.LastErrorAt = now;
        // Log a problem when it starts or changes, then only now and then:
        // a key refused for a week must not write a week of identical lines
        // into the Event Log.
        if (_lastLoggedProblem is { } last && last.State == state && last.Message == message
            && now - last.At < RepeatProblemLogEvery)
        {
            return;
        }
        _lastLoggedProblem = (state, message, now);
        _log.Log(level, "{Message}", message);
    }

    private void ClearProblem(string message)
    {
        _lastLoggedProblem = null;
        _status.NextTryAt = null;
        SetState(ProcessorState.Idle, message);
    }

    /// <summary>After a pass with nothing more to send now.</summary>
    private void SettleState()
    {
        _status.NextTryAt = null;
        if (_status.Waiting > 0)
        {
            SetState(ProcessorState.Waiting, $"{_status.Waiting:N0} file(s) not ready yet.");
        }
        else
        {
            SetState(ProcessorState.Idle, "Up to date.");
        }
    }

    private void SetState(string state, string message)
    {
        _status.State = state;
        _status.Message = message;
    }

    private void LogProgress()
    {
        var now = Now;
        if (now - _lastProgressLog < ProgressEvery) return;
        if (_lastProgressLog != default && _sentSinceProgress > 0)
        {
            _log.LogInformation("Sent {Count} file(s) in the last {Minutes:N0} minute(s); {Waiting:N0} waiting.",
                _sentSinceProgress, (now - _lastProgressLog).TotalMinutes, _status.Waiting);
        }
        _lastProgressLog = now;
        _sentSinceProgress = 0;
    }

    private void FlushStatus(bool force)
    {
        var now = Now;
        if (!force && now - _lastStatusWrite < StatusEvery) return;
        _lastStatusWrite = now;
        _status.UpdatedAt = now;
        try
        {
            _writeStatus(_status);
            _statusWriteFailed = false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            if (!_statusWriteFailed) _log.LogWarning("Could not write {Status}: {Error}", _paths.Status, ex.Message);
            _statusWriteFailed = true;
        }
    }

    /// <summary>ERROR_SHARING_VIOLATION (32) or ERROR_LOCK_VIOLATION (33).</summary>
    internal static bool IsSharingViolation(IOException ex) => (ex.HResult & 0xFFFF) is 32 or 33;

    private DateOnly Today(DateTimeOffset at) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, _time.LocalTimeZone).DateTime);

    private static TimeSpan Min(TimeSpan a, TimeSpan b)
    {
        var m = a < b ? a : b;
        return m < TimeSpan.Zero ? TimeSpan.Zero : m;
    }

    private static TimeSpan Max(TimeSpan a, TimeSpan b) => a > b ? a : b;

    private static string Describe(TimeSpan t) =>
        t.TotalMinutes >= 1 ? $"{t.TotalMinutes:N0} minute(s)" : $"{t.TotalSeconds:N0} second(s)";
}
