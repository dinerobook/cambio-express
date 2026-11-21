using System.Globalization;
using Microsoft.Extensions.Logging;

namespace DineroBook.Processor;

/// <summary>
/// The Processor's pipeline: list the folder → wait until each file held
/// still → read its business day → send, several at a time → ledger. In the
/// service the folder is the local inbox: <see cref="OutboxCollector"/> copies
/// each file there from Passport's BOOutbox the moment it is complete, and a
/// file's inbox copy is deleted once the server has it (or refused it for
/// good).
/// The service calls <see cref="RunCycleAsync"/>, then
/// <see cref="WaitAsync"/> for the time it returns (or until an upload
/// finishes), in a loop.
/// <para>
/// The rules it keeps:
/// <list type="bullet">
/// <item>read only — the engine never moves, renames, deletes or locks a
/// Passport file (only the collector may delete one, and only when the store
/// ticked "Delete files from XMLGateway");</item>
/// <item>a file goes up once its size and time held still across two
/// polls;</item>
/// <item>business days in order (<see cref="UploadScheduler"/>): a day's
/// files go in parallel, and no file of a later day goes while a file of an
/// earlier day is still on its way — the server books day D as soon as a
/// file of a later day arrives;</item>
/// <item>a slow or failing file never holds up files of its own day; it is
/// retried with backoff;</item>
/// <item>nothing is ever dropped: every answer but "accepted" and "refused
/// for good (422)" leaves the file to be tried again;</item>
/// <item>every file in the folder goes, and no fixed number at once: the
/// server's rate limit (<see cref="UploadPacer"/>) is the only limit (owner,
/// 2026-11-18);</item>
/// <item>a network share that stops answering is "folder unavailable", never
/// a hang (<see cref="PassportFolder"/>'s time limits).</item>
/// </list>
/// All bookkeeping happens on the thread that calls RunCycleAsync; an
/// upload task only reads the file and talks to the server.
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

    /// <summary>Business days read per pass (a first run in a big folder
    /// reads them over several passes).</summary>
    public const int DayReadsPerCycle = 500;

    /// <summary>This many failed tries in a row, whatever the file, means
    /// DineroBook (or the network) is down: one upload at a time, with the
    /// backoff ladder between them, until one goes through.</summary>
    public const int OutageStreak = 4;

    private static readonly TimeSpan StatusEvery = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ProgressEvery = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan RepeatProblemLogEvery = TimeSpan.FromMinutes(30);

    private readonly DataPaths _paths;
    private readonly IConfigSource _config;
    private readonly IPassportFolder _folder;
    private readonly Func<Uri, string, IAgentUploader> _uploaderFor;
    private readonly TimeProvider _time;
    private readonly ILogger _log;
    private readonly Action<ProcessorStatus> _writeStatus;

    private readonly string? _inbox;
    private readonly Action<string>? _onFinished;
    private readonly Func<SourceInfo>? _source;
    private volatile bool _nudged;
    private readonly UploadScheduler _schedule = new();
    private readonly UploadPacer _pacer = new();
    private readonly List<InFlight> _inFlight = new();
    private readonly ProcessorStatus _status;
    private readonly object _signalGate = new();
    private TaskCompletionSource _activity = NewSignal();

    private FileLedger? _sent;
    private FileLedger? _skipped;
    private EngineConfig? _cfg;
    private IAgentUploader? _uploader;
    private int _generation;
    private readonly int _maxInFlight;
    private string _watchFolder = "";
    private DateTimeOffset _nextSweepAt = DateTimeOffset.MinValue;
    private bool _folderOk = true;

    private DateTimeOffset _pausedUntil;
    private int _failureStreak;

    private DateOnly _today;
    private int _todayCount;
    private DateTimeOffset _lastStatusWrite;
    private DateTimeOffset _lastProgressLog;
    private int _sentSinceProgress;
    private (string State, string Message, DateTimeOffset At)? _lastLoggedProblem;
    private bool _statusWriteFailed;

    private sealed record InFlight(TrackedFile File, BusinessDay Day, int Generation, Task<Attempt> Task);

    /// <summary>How collecting from Passport's folder is going
    /// (<see cref="OutboxCollector"/>), for the status page.</summary>
    public readonly record struct SourceInfo(string Problem, int Missed);

    private enum AttemptKind { Uploaded, NotReady, Gone, DayChanged, ReadFailed, Cancelled }

    private sealed record Attempt(AttemptKind Kind, UploadResult? Result = null, BusinessDay Day = default, string Error = "");

    public ProcessorEngine(
        DataPaths paths,
        IConfigSource config,
        IPassportFolder folder,
        Func<Uri, string, IAgentUploader> uploaderFor,
        TimeProvider time,
        ILogger log,
        string version,
        Action<ProcessorStatus>? writeStatus = null,
        int? maxInFlight = null,
        string? inbox = null,
        Action<string>? onFinished = null,
        Func<SourceInfo>? source = null)
    {
        // inbox: send from this local folder instead of the Passport folder
        // (the service); onFinished: a file is done with (accepted, or
        // refused for good) — the service deletes its inbox copy; source:
        // how the collector is doing.
        _inbox = inbox;
        _onFinished = onFinished;
        _source = source;
        _paths = paths;
        _config = config;
        _folder = folder;
        _uploaderFor = uploaderFor;
        _time = time;
        _log = log;
        _writeStatus = writeStatus ?? (s => s.Write(paths.Status));
        // Tests only: the real service has no fixed limit.
        _maxInFlight = maxInFlight ?? int.MaxValue;
        _status = new ProcessorStatus { Version = version, Running = true, StartedAt = time.GetUtcNow() };
    }

    /// <summary>The status as last written (for tests and the console).</summary>
    public ProcessorStatus Status => _status;

    /// <summary>The schedule (for tests).</summary>
    public UploadScheduler Schedule => _schedule;

    public int UploadsInFlight => _inFlight.Count;

    private DateTimeOffset Now => _time.GetUtcNow();

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private void Signal()
    {
        lock (_signalGate) _activity.TrySetResult();
    }

    /// <summary>A file just arrived in the inbox: list it on the next pass
    /// instead of at the next poll. Safe from any thread.</summary>
    public void Nudge()
    {
        _nudged = true;
        Signal();
    }

    /// <summary>Waits <paramref name="wait"/>, or less when an upload
    /// finishes first.</summary>
    public async Task WaitAsync(TimeSpan wait, CancellationToken ct)
    {
        Task signal;
        lock (_signalGate) signal = _activity.Task;
        if (wait <= TimeSpan.Zero || signal.IsCompleted) return;
        await Task.WhenAny(Task.Delay(wait, _time, ct), signal).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
    }

    /// <summary>One pass. It never waits on an upload (those run on their
    /// own), so it finishes at once; the returned time is when the next
    /// pass is due.</summary>
    public Task<TimeSpan> RunCycleAsync(CancellationToken ct) => Task.FromResult(RunCycle(ct));

    private TimeSpan RunCycle(CancellationToken ct)
    {
        lock (_signalGate)
        {
            if (_activity.Task.IsCompleted) _activity = NewSignal();
        }
        if (!OpenLedgers())
        {
            FlushStatus(force: true);
            return RecheckEvery;
        }
        Collect();

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

        var now = Now;
        if (_nudged)
        {
            _nudged = false;
            _nextSweepAt = DateTimeOffset.MinValue;
        }
        if (now >= _nextSweepAt) Sweep(now, poll);
        var moreDays = _folderOk && ReadDays();

        // Start what may go; uploads that finish at once make room for more.
        for (var i = 0; i < 50 && _folderOk; i++)
        {
            var started = Dispatch(ct);
            var finished = Collect();
            if (!started && !finished) break;
        }

        Summarize();
        FlushStatus(force: true);
        return NextWake(poll, moreDays);
    }

    /// <summary>At shutdown: lets uploads in flight finish (briefly) and
    /// records the ones that went through.</summary>
    public async Task DrainAsync(TimeSpan timeout)
    {
        if (_inFlight.Count > 0)
        {
            await Task.WhenAny(Task.WhenAll(_inFlight.Select(x => x.Task)), Task.Delay(timeout)).ConfigureAwait(false);
        }
        Collect();
    }

    /// <summary>Marks the status stopped (service shutting down).</summary>
    public void Stopped()
    {
        _status.Running = false;
        _status.Uploading = 0;
        SetState(ProcessorState.Stopped, "The service is stopped.");
        _status.NextTryAt = null;
        FlushStatus(force: true);
    }

    // ── Sweep and business days ──

    private void Sweep(DateTimeOffset now, TimeSpan poll)
    {
        List<FileSnapshot> pending;
        try
        {
            var listed = _folder.List(_watchFolder);
            if (_inbox is not null)
            {
                // An inbox copy of a file already dealt with (the service
                // stopped between the answer and the delete): tidy it away.
                foreach (var f in listed.Where(f => _sent!.Contains(f.Name) || _skipped!.Contains(f.Name)))
                {
                    Finished(f.Name);
                }
            }
            pending = listed
                .Where(f => FileNames.Sendable(f.Name) && !_sent!.Contains(f.Name) && !_skipped!.Contains(f.Name))
                .ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                       or System.Security.SecurityException or ArgumentException)
        {
            FolderDown(ex.Message);
            _nextSweepAt = now + poll;
            return;
        }
        if (!_folderOk || _status.State == ProcessorState.FolderUnavailable)
        {
            _folderOk = true;
            ClearProblem($"The Passport folder {_watchFolder} can be read again.");
        }
        _schedule.Observe(pending, now);
        var backlog = _schedule.Files.Count(f => f.Stage is FileStage.Ready or FileStage.Retrying) > BacklogThreshold;
        _nextSweepAt = now + (backlog ? Max(poll, BacklogSweepEvery) : poll);
    }

    private void FolderDown(string error)
    {
        _folderOk = false;
        if (_inbox is not null)
        {
            Problem(ProcessorState.FolderUnavailable, $"Cannot read this computer's inbox {_watchFolder}: {error}", LogLevel.Error);
            return;
        }
        // A mapped drive letter (Z:) is the signed-in person's; the service never sees it.
        var hint = MissingDrive(_watchFolder)
            ? " The service does not see mapped drive letters: choose the folder again in DineroBook Manager, which saves its network path."
            : "";
        Problem(ProcessorState.FolderUnavailable,
            $"Cannot open the Passport folder {_watchFolder}: {error}" + hint, LogLevel.Error);
    }

    /// <summary>Reads business days that are still needed. True when more
    /// are waiting than one pass reads.</summary>
    private bool ReadDays()
    {
        var batch = _schedule.NeedDay(DayReadsPerCycle);
        foreach (var f in batch)
        {
            var complete = f.Stage != FileStage.Settling;
            try
            {
                _schedule.SetDay(f.Name, _folder.ReadDay(f.Snapshot, complete), final: complete);
            }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
            {
                _schedule.Gone(f.Name);
            }
            catch (FolderTimeoutException ex)
            {
                // The share stopped answering: no more reads until a listing works.
                _schedule.DayUnreadable(f.Name, ex.Message);
                FolderDown(ex.Message);
                return false;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Locked for a moment, or not readable: tried again next pass.
                _schedule.DayUnreadable(f.Name, ex.Message);
            }
        }
        return batch.Count >= DayReadsPerCycle;
    }

    // ── Sending ──

    private bool Dispatch(CancellationToken ct)
    {
        var now = Now;
        if (_pausedUntil > now || _uploader is null) return false;
        var limit = _failureStreak >= OutageStreak ? 1 : _maxInFlight;
        var slots = limit - _inFlight.Count;
        if (slots <= 0) return false;

        var started = false;
        foreach (var f in _schedule.NextToStart(now, slots))
        {
            if (f.Name.Length > ServerContract.MaxFilenameLength)
            {
                Skip(f.Name, "name_too_long",
                    $"the name is longer than the {ServerContract.MaxFilenameLength} characters the server takes");
                started = true;
                continue;
            }
            if (f.Snapshot.Length > ServerContract.MaxFileBytes)
            {
                Skip(f.Name, "too_large", $"{f.Snapshot.Length:N0} bytes; the server takes up to {ServerContract.MaxFileBytes:N0}");
                started = true;
                continue;
            }
            if (_pacer.WaitBeforeNext(now) > TimeSpan.Zero) break;
            _pacer.Record(now);
            _schedule.Started(f);
            var task = SendAsync(f.Snapshot, f.Day, _uploader, ct);
            _inFlight.Add(new InFlight(f, f.Day, _generation, task));
            _ = task.ContinueWith(_ => Signal(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            started = true;
        }
        return started;
    }

    /// <summary>Reads one file and sends it. Touches no engine state.</summary>
    private async Task<Attempt> SendAsync(FileSnapshot file, BusinessDay day, IAgentUploader uploader, CancellationToken ct)
    {
        try
        {
            byte[]? content;
            try
            {
                content = await _folder.ReadAsync(file, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
            {
                return new Attempt(AttemptKind.Gone);
            }
            catch (IOException ex) when (IsSharingViolation(ex))
            {
                return new Attempt(AttemptKind.NotReady);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new Attempt(AttemptKind.ReadFailed, Error: "cannot read the file: " + ex.Message);
            }
            if (content is null) return new Attempt(AttemptKind.NotReady);

            // The bytes about to go decide the day, not an earlier look.
            var actual = BusinessDateReader.Read(content, complete: true);
            if (actual != day) return new Attempt(AttemptKind.DayChanged, Day: actual);

            var result = await uploader.UploadAsync(file.Name, content, ct).ConfigureAwait(false);
            return new Attempt(AttemptKind.Uploaded, result);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return new Attempt(AttemptKind.Cancelled);
        }
        catch (Exception ex)
        {
            return new Attempt(AttemptKind.Uploaded, UploadAnswers.FromException(ex));
        }
    }

    /// <summary>Takes in every upload that has finished. True when any did.</summary>
    private bool Collect()
    {
        var done = _inFlight.Where(x => x.Task.IsCompleted).ToList();
        foreach (var x in done)
        {
            _inFlight.Remove(x);
            var attempt = x.Task.IsCompletedSuccessfully
                ? x.Task.Result
                : new Attempt(AttemptKind.Uploaded, UploadAnswers.FromException(x.Task.Exception?.GetBaseException() ?? new IOException("upload failed")));
            Apply(x, attempt);
        }
        return done.Count > 0;
    }

    private void Apply(InFlight x, Attempt attempt)
    {
        var name = x.File.Name;
        switch (attempt.Kind)
        {
            case AttemptKind.Gone:
                _log.LogInformation("{File} was removed from the folder before it could be sent.", name);
                _schedule.Gone(name);
                return;
            case AttemptKind.NotReady:
                _schedule.Unsettle(name);
                return;
            case AttemptKind.Cancelled:
                _schedule.Requeue(name);
                return;
            case AttemptKind.DayChanged:
                _log.LogInformation("{File}: business day is {Day}, not {Expected}; it waits for its own day.", name, attempt.Day, x.Day);
                _schedule.SetDay(name, attempt.Day, final: true);
                _schedule.Requeue(name);
                return;
            case AttemptKind.ReadFailed:
                Failed(name, attempt.Error);
                return;
        }

        var result = attempt.Result!;
        // A refusal for a key or server that has since been replaced
        // says nothing about the new one.
        var current = x.Generation == _generation;
        switch (result.Verdict)
        {
            case UploadVerdict.Accepted:
                Accepted(name, x.Day, result.Accepted!);
                break;
            case UploadVerdict.RejectedForGood:
                Skip(name, "rejected", $"HTTP {result.Status}: {result.Detail}");
                _failureStreak = 0;
                break;
            case UploadVerdict.KeyRejected:
                _schedule.Requeue(name);
                if (current)
                {
                    Pause(RetryPolicy.BlockedPause, ProcessorState.KeyRejected,
                        "DineroBook refused the agent key. Open DineroBook Manager and choose Connect again.");
                }
                break;
            case UploadVerdict.StoreClosed:
                _schedule.Requeue(name);
                if (current)
                {
                    Pause(RetryPolicy.BlockedPause, ProcessorState.StoreClosed,
                        "DineroBook is not taking uploads for this store: " + result.Detail);
                }
                break;
            case UploadVerdict.ContractMismatch:
                _schedule.Requeue(name);
                if (current)
                {
                    Pause(RetryPolicy.BlockedPause, ProcessorState.UpdateNeeded,
                        "DineroBook refused the upload format; this DineroBook Processor needs an update. " + result.Detail);
                }
                break;
            case UploadVerdict.RateLimited:
                _schedule.Requeue(name);
                if (current)
                {
                    Pause(RetryPolicy.RateLimitedPause, ProcessorState.RetryLater,
                        "DineroBook asked us to slow down (too many uploads). Carrying on in a minute.", LogLevel.Warning);
                }
                break;
            default:
                // 5xx (two uploads colliding on the server end up here too),
                // network, odd answers: this file waits, the others go on.
                Failed(name, result.Detail);
                break;
        }
    }

    private void Accepted(string name, BusinessDay day, AcceptedFile answer)
    {
        var at = Now;
        try
        {
            _sent!.Add(name, at, answer.Outcome);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Still remembered for this run; after a restart the server
            // would answer "duplicate".
            _log.LogError("Could not write {Ledger}: {Error}", _paths.SentLedger, ex.Message);
        }
        _schedule.Done(name);
        _failureStreak = 0;
        Finished(name);

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
        _status.LastUploadFile = name;
        _status.LastUploadResult = answer.Outcome;
        if (_lastLoggedProblem is not null && _pausedUntil <= at)
        {
            _log.LogInformation("Uploads are going through again.");
            _lastLoggedProblem = null;
        }

        switch (answer.Outcome)
        {
            case "duplicate":
                _log.LogInformation("{File}: already on the server (duplicate).", name);
                break;
            case "parse_error":
                _log.LogWarning("{File}: sent; the server could not read it (parse_error: {Error}).", name, answer.ParseError);
                break;
            default:
                _log.LogInformation("{File}: staged (business day {Day}).", name, answer.BusinessDate ?? day.ToString());
                break;
        }
        LogProgress();
    }

    private void Skip(string name, string outcome, string why)
    {
        try
        {
            _skipped!.Add(name, Now, outcome + ": " + why);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogError("Could not write {Ledger}: {Error}", _paths.SkippedLedger, ex.Message);
        }
        _schedule.Done(name);
        Finished(name);
        _status.SkippedTotal = _skipped!.Count;
        _log.LogWarning("{File}: not sent, and will not be tried again ({Why}).", name, why);
    }

    /// <summary>The file is done with; the service deletes its inbox copy.
    /// A failure there is only logged: the ledger already keeps it from
    /// going again.</summary>
    private void Finished(string name)
    {
        if (_onFinished is null) return;
        try
        {
            _onFinished(name);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log.LogWarning("Could not delete the inbox copy of {File}: {Error}", name, ex.Message);
        }
    }

    /// <summary>A try that did not work (5xx, network, odd answer, a read
    /// error). That file is retried on the ladder; files of its own day go
    /// on, later days wait for it.</summary>
    private void Failed(string name, string detail)
    {
        var now = Now;
        _failureStreak++;
        var tries = (_schedule.Get(name)?.Failures ?? 0) + 1;
        var wait = RetryPolicy.AfterFailures(tries);
        _schedule.Failed(name, detail, now + wait);
        var stuck = tries >= RetryPolicy.StuckAfter;
        Problem(ProcessorState.RetryLater,
            (stuck ? $"Stuck on {name} ({tries} tries): " : $"Could not send {name}: ")
            + detail + $". Trying it again in {Describe(wait)}; files of later business days wait for it.",
            stuck ? LogLevel.Error : LogLevel.Warning);
        if (_failureStreak >= OutageStreak)
        {
            // Everything is failing: DineroBook or the network is down.
            // One upload at a time, spaced on the ladder, until one works.
            var pause = RetryPolicy.AfterFailures(_failureStreak - OutageStreak + 1);
            _pausedUntil = now + pause;
            _status.NextTryAt = _pausedUntil;
        }
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
        _watchFolder = _inbox ?? cfg.Settings.WatchFolder;
        _status.ApiUrl = cfg.ApiBase?.ToString().TrimEnd('/') ?? cfg.Settings.ApiUrl;
        _status.WatchFolder = cfg.Settings.WatchFolder;
        _status.StoreName = cfg.Settings.StoreName;
        if (cfg.Problem.Length > 0 && cfg.CanRun) _log.LogWarning("{Problem}", cfg.Problem);
        if (keyChanged)
        {
            _generation++;
            _uploader = cfg.CanRun ? _uploaderFor(cfg.ApiBase!, cfg.AgentKey!) : null;
            // A new key (or server) means someone acted: try at once.
            _pausedUntil = DateTimeOffset.MinValue;
            _failureStreak = 0;
            _status.NextTryAt = null;
            if (cfg.CanRun)
            {
                _log.LogInformation("Sending every file in {Folder} to {Api} for {Store}, as many at once as DineroBook's rate limit allows.",
                    _inbox is null ? _watchFolder : $"{cfg.Settings.WatchFolder} (from its copies in {_inbox})", _status.ApiUrl,
                    cfg.Settings.StoreName.Length > 0 ? cfg.Settings.StoreName : "this store");
                ClearProblem("Ready to send.");
            }
        }
        if (folderChanged && _inFlight.Count == 0 && _inbox is null)
        {
            _schedule.Reset();
            _nextSweepAt = DateTimeOffset.MinValue;
        }
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

    /// <summary>The status after a pass (a pause keeps its own message).</summary>
    private void Summarize()
    {
        var now = Now;
        _status.Uploading = _inFlight.Count;
        _status.Waiting = _schedule.Files.Count(f => f.Snapshot.Length != 0);
        var held = _schedule.HeldBy(now);
        _status.WaitingOn = held is { } h
            ? $"{h.File.Name}" + (h.File.Day.Kind == DayKind.Dated ? $" (business day {h.File.Day})" : "") + $": {h.Why}"
            : "";

        var source = _source?.Invoke() ?? default;
        _status.MissedTotal = source.Missed;
        if (_pausedUntil > now || !_folderOk) return;
        if (!string.IsNullOrEmpty(source.Problem))
        {
            // Passport's folder cannot be read (or a delete failed): say so,
            // and keep sending what is already in the inbox.
            _status.LastError = source.Problem;
            _status.LastErrorAt ??= now;
            SetState(ProcessorState.FolderUnavailable, source.Problem
                + (_status.Waiting > 0 ? $" {_status.Waiting:N0} file(s) already copied are still being sent." : ""));
            return;
        }
        var heldNote = _status.WaitingOn.Length > 0 ? $" Later business days wait on {_status.WaitingOn}." : "";
        if (_inFlight.Count > 0 || _schedule.Files.Any(f => f.Stage == FileStage.Ready))
        {
            _status.NextTryAt = null;
            SetState(ProcessorState.Sending, $"Sending {_status.Waiting:N0} file(s), {_inFlight.Count} at a time now." + heldNote);
        }
        else if (_status.Waiting > 0)
        {
            SetState(ProcessorState.Waiting, $"{_status.Waiting:N0} file(s) not ready yet." + heldNote);
        }
        else
        {
            _status.NextTryAt = null;
            SetState(ProcessorState.Idle, "Up to date.");
        }
    }

    private TimeSpan NextWake(TimeSpan poll, bool moreDays)
    {
        if (moreDays) return TimeSpan.Zero;
        var now = Now;
        var wake = RecheckEvery;
        void Consider(TimeSpan t)
        {
            if (t < wake) wake = t < TimeSpan.Zero ? TimeSpan.Zero : t;
        }
        Consider(_nextSweepAt - now);
        if (_pausedUntil > now)
        {
            Consider(_pausedUntil - now);
        }
        else
        {
            var limit = _failureStreak >= OutageStreak ? 1 : _maxInFlight;
            if (_inFlight.Count < limit && _schedule.NextToStart(now, 1).Count > 0) Consider(_pacer.WaitBeforeNext(now));
            if (_schedule.NextRetryAt is { } r) Consider(r - now);
        }
        return wake;
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
        if (_lastProgressLog != default && _sentSinceProgress > 1)
        {
            _log.LogInformation("Sent {Count} file(s) in the last {Minutes:N0} minute(s); {Waiting:N0} waiting.",
                _sentSinceProgress, (now - _lastProgressLog).TotalMinutes, _schedule.Count);
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

    /// <summary>A path on a drive letter this process has no such drive for.</summary>
    internal static bool MissingDrive(string path)
    {
        if (path.Length < 2 || path[1] != ':' || !char.IsAsciiLetter(path[0])) return false;
        try
        {
            return !Directory.Exists(path[..2] + @"\");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>ERROR_SHARING_VIOLATION (32) or ERROR_LOCK_VIOLATION (33).</summary>
    internal static bool IsSharingViolation(IOException ex) => (ex.HResult & 0xFFFF) is 32 or 33;

    private DateOnly Today(DateTimeOffset at) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, _time.LocalTimeZone).DateTime);

    private static TimeSpan Max(TimeSpan a, TimeSpan b) => a > b ? a : b;

    private static string Describe(TimeSpan t) =>
        t.TotalMinutes >= 1 ? $"{t.TotalMinutes:N0} minute(s)" : $"{t.TotalSeconds:N0} second(s)";
}
