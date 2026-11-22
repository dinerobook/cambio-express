using Microsoft.Extensions.Logging;

namespace DineroBook.Processor;

/// <summary>
/// Copies each file Passport writes to its BOOutbox share into this
/// computer's own inbox (<see cref="DataPaths.Inbox"/>) the moment the file
/// is complete; <see cref="ProcessorEngine"/> sends from the inbox.
/// <para>
/// Why a copy first: Modisoft's service, which many stores run beside
/// DineroBook, copies every file to its own temp folder and deletes it from
/// BOOutbox at once. A file read only when it is time to send it may be gone
/// by then. The owner's LdPosService copies at once and runs beside Modisoft
/// at 50+ stores (owner, 2026-11-20); this does the same.
/// </para>
/// <list type="bullet">
/// <item>A file is noticed by the watcher (<see cref="IOutboxWatcher"/>) the
/// moment it appears, and by a listing of the folder every poll in case the
/// watcher missed it or died.</item>
/// <item>It is copied once nobody is writing it: opened for reading while
/// refusing other writers (Passport still writing it means "not yet", tried
/// again every <see cref="RetryBusyEvery"/>). Other programs may still read
/// it and delete it while it is open.</item>
/// <item>The copy is written beside the inbox and moved in whole, then the
/// name goes in that day's <c>state\collected\YYYY-MM-DD.txt</c>
/// (<see cref="DailyLedger"/>), so a file is never copied twice — not after
/// a restart, and not when it stays in BOOutbox.</item>
/// <item>The watcher is checked on every pass and made again, at most every
/// <see cref="WatcherRetryEvery"/> (30 s), when it failed, when the share
/// came back after being unreachable (a watcher on a dropped share is dead
/// even when it says nothing), or when a listing finds a file it should
/// have reported. Store PCs are often on Wi-Fi: the network drops.</item>
/// <item>Only with "Delete files from XMLGateway" ticked
/// (<see cref="ProcessorSettings.DeleteFromOutbox"/>) is the original deleted,
/// after the copy is safe. A delete that fails is reported, never fatal.</item>
/// <item>Every call to the share has a time limit (a dead share does not
/// fail, it waits).</item>
/// </list>
/// All of it runs on the thread that calls <see cref="RunOnce"/>.
/// </summary>
public sealed class OutboxCollector : IDisposable
{
    public static readonly TimeSpan RetryBusyEvery = TimeSpan.FromMilliseconds(250);
    /// <summary>A file still being written (or still empty) after this long
    /// is left to the next listing instead of being tried 4 times a second.</summary>
    public static readonly TimeSpan BusyGiveUpAfter = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan CopyTimeout = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan DeleteTimeout = TimeSpan.FromSeconds(15);
    /// <summary>A watcher is made again at most this often (owner: retry
    /// every 30 seconds).</summary>
    public static readonly TimeSpan WatcherRetryEvery = TimeSpan.FromSeconds(30);
    /// <summary>A file a listing found that the watcher still has not
    /// reported this long after (by this computer's clock, never the file's
    /// time: Passport's clock may be off) means the watcher died without a
    /// word.</summary>
    public static readonly TimeSpan WatcherGrace = TimeSpan.FromSeconds(2);
    public static readonly TimeSpan RecheckEvery = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan RepeatProblemLogEvery = TimeSpan.FromMinutes(30);

    private readonly DataPaths _paths;
    private readonly IConfigSource _config;
    private readonly IPassportFolder _folder;
    private readonly Func<string, IOutboxWatcher?>? _watcherFor;
    private readonly TimeProvider _time;
    private readonly ILogger _log;
    private readonly Action? _onCopied;
    private readonly TimeSpan _copyTimeout;

    private readonly Dictionary<string, Candidate> _candidates = new(StringComparer.OrdinalIgnoreCase);
    private DailyLedger? _collected;
    private IOutboxWatcher? _watcher;
    private string _watching = "";
    private readonly HashSet<string> _watcherSaw = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Files a listing found that the watcher had not reported, and
    /// when: the watcher has <see cref="WatcherGrace"/> to report them.</summary>
    private readonly Dictionary<string, DateTimeOffset> _unreported = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>The first listing after a watcher starts only shows what was
    /// already there; files in it never count against the watcher.</summary>
    private bool _watcherListed;
    /// <summary>Names in the last listing: a file is new only the first time
    /// a listing shows it (one left for later, busy or hidden, is not).</summary>
    private HashSet<string> _listedBefore = new(StringComparer.OrdinalIgnoreCase);
    private DateTimeOffset _nextWatcherTry = DateTimeOffset.MinValue;
    private DateTimeOffset _nextScanAt = DateTimeOffset.MinValue;
    private string _source = "";
    private bool _delete;
    private (string Message, DateTimeOffset At)? _lastLogged;

    private sealed class Candidate(DateTimeOffset firstSeen)
    {
        public DateTimeOffset FirstSeen { get; } = firstSeen;
        public DateTimeOffset NextTry { get; set; } = firstSeen;
    }

    private enum Outcome { Copied, Busy, Gone, Skip, Failed }

    /// <param name="watcherFor">Makes the watcher for a folder (null: never
    /// watch, only list — tests).</param>
    /// <param name="onCopied">Called after each file lands in the inbox, so
    /// the sender looks at once.</param>
    public OutboxCollector(
        DataPaths paths,
        IConfigSource config,
        IPassportFolder folder,
        TimeProvider time,
        ILogger log,
        Func<string, IOutboxWatcher?>? watcherFor = null,
        Action? onCopied = null,
        TimeSpan? copyTimeout = null)
    {
        _paths = paths;
        _config = config;
        _folder = folder;
        _time = time;
        _log = log;
        _watcherFor = watcherFor;
        _onCopied = onCopied;
        _copyTimeout = copyTimeout ?? CopyTimeout;
    }

    /// <summary>What is wrong with reaching Passport's folder right now
    /// ("" when nothing is): shown on the Manager's status page.</summary>
    public string Problem { get; private set; } = "";

    /// <summary>Files seen in the folder and not yet copied.</summary>
    public int Pending => _candidates.Count;

    public int CopiedCount { get; private set; }
    public int DeletedCount { get; private set; }

    /// <summary>Files that disappeared from the folder before they could be
    /// copied (another program took them first).</summary>
    public int MissedCount { get; private set; }

    /// <summary>Completes when the watcher notices something; the service
    /// waits on it next to the time <see cref="RunOnce"/> returns.</summary>
    public Task Noticed => _watcher?.Noticed ?? Task.Delay(Timeout.Infinite);

    private DateTimeOffset Now => _time.GetUtcNow();

    /// <summary>One pass: take what the watcher saw, list the folder when a
    /// listing is due, copy what is ready. Returns when the next pass is due.</summary>
    public TimeSpan RunOnce()
    {
        var cfg = _config.Current(out _);
        if (!cfg.CanCollect) return RecheckEvery;
        if (!OpenLedger()) return RecheckEvery;

        var settings = cfg.Settings;
        if (!string.Equals(_source, settings.WatchFolder, StringComparison.OrdinalIgnoreCase))
        {
            _source = settings.WatchFolder;
            _candidates.Clear();
            _listedBefore.Clear();
            _nextScanAt = DateTimeOffset.MinValue;
            StopWatcher();
        }
        _delete = settings.DeleteFromOutbox;
        var poll = TimeSpan.FromSeconds(settings.EffectivePollSeconds);
        var now = Now;

        if (_watcher is not null)
        {
            foreach (var name in _watcher.TakeNames())
            {
                _watcherSaw.Add(name);
                _unreported.Remove(name);
                Notice(name, now);
            }
            CheckWatcher(now);
        }
        EnsureWatcher(now);
        if (now >= _nextScanAt)
        {
            Scan(now);
            _nextScanAt = now + poll;
        }

        foreach (var name in _candidates.Where(kv => kv.Value.NextTry <= now).Select(kv => kv.Key).ToList())
        {
            Collect(name);
        }

        var next = _nextScanAt;
        foreach (var c in _candidates.Values)
        {
            if (c.NextTry < next) next = c.NextTry;
        }
        var wait = next - Now;
        return wait < TimeSpan.Zero ? TimeSpan.Zero : wait > RecheckEvery ? RecheckEvery : wait;
    }

    /// <summary>A name the watcher (or a listing) reported.</summary>
    internal void Notice(string name, DateTimeOffset now)
    {
        if (!FileNames.Sendable(name) || name.StartsWith('.')) return;
        if (_candidates.ContainsKey(name) || Known(name)) return;
        _candidates[name] = new Candidate(now);
    }

    /// <summary>Copied before (now or in an earlier run), or waiting in the
    /// inbox to be sent.</summary>
    private bool Known(string name) =>
        _collected!.Contains(name) || File.Exists(Path.Combine(_paths.Inbox, name));

    private void Scan(DateTimeOffset now)
    {
        IReadOnlyList<FileSnapshot> listing;
        try
        {
            listing = _folder.List(_source);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                                       or System.Security.SecurityException or ArgumentException)
        {
            var hint = ProcessorEngine.MissingDrive(_source)
                ? " The service does not see mapped drive letters: choose the folder again in DineroBook Manager, which saves its network path."
                : "";
            Report($"Cannot open the Passport folder {_source}: {ex.Message}" + hint, LogLevel.Error);
            return;
        }
        if (Problem.StartsWith("Cannot open the Passport folder", StringComparison.Ordinal))
        {
            Clear($"The Passport folder {_source} can be read again.");
            // A watcher on a share that dropped is dead even when it said
            // nothing: make a new one.
            if (_watcher is not null) StopWatcher();
        }
        var watching = _watcher is { Alive: true };
        var listed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in listing)
        {
            listed.Add(f.Name);
            if (f.Length == 0) continue;
            // New since the last listing, which itself came after this
            // watcher started, and the watcher has not said a word about it.
            if (watching && _watcherListed && !_listedBefore.Contains(f.Name) && !_watcherSaw.Contains(f.Name)
                && !_candidates.ContainsKey(f.Name) && !Known(f.Name))
            {
                _unreported.TryAdd(f.Name, now);
            }
            Notice(f.Name, now);
        }
        _listedBefore = listed;
        if (watching) _watcherListed = true;
    }

    /// <summary>A file a listing found and the watcher has still not reported
    /// after <see cref="WatcherGrace"/>: the watcher has died without a word
    /// (a Passport reboot, a stale share session, Wi-Fi dropping). The file is
    /// already copied; a new watcher is made (at most every
    /// <see cref="WatcherRetryEvery"/>).</summary>
    private void CheckWatcher(DateTimeOffset now)
    {
        var missed = _unreported.FirstOrDefault(kv => now - kv.Value >= WatcherGrace).Key;
        if (missed is null) return;
        _log.LogWarning("The watcher on {Folder} did not report {File}; making a new one.", _watching, missed);
        StopWatcher();
    }

    private void Collect(string name)
    {
        var candidate = _candidates[name];
        var source = Path.Combine(_source, name);
        var incoming = Path.Combine(_paths.Incoming, name);
        Outcome outcome;
        string error = "";
        try
        {
            Directory.CreateDirectory(_paths.Incoming);
            outcome = PassportFolder.Wait(Task.Run(() => CopyWhole(source, incoming)), _copyTimeout, name);
        }
        catch (FolderTimeoutException ex)
        {
            Report($"Cannot open the Passport folder {_source}: {ex.Message}", LogLevel.Error);
            candidate.NextTry = Now + TimeSpan.FromSeconds(5);
            return;
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            outcome = Outcome.Gone;
        }
        catch (IOException ex) when (ProcessorEngine.IsSharingViolation(ex))
        {
            outcome = Outcome.Busy;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            outcome = Outcome.Failed;
            error = ex.Message;
        }

        var now = Now;
        switch (outcome)
        {
            case Outcome.Busy:
                if (now - candidate.FirstSeen >= BusyGiveUpAfter)
                {
                    // Still written to, or still empty: the next listing
                    // picks it up again.
                    _candidates.Remove(name);
                }
                else
                {
                    candidate.NextTry = now + RetryBusyEvery;
                }
                return;
            case Outcome.Gone:
                _candidates.Remove(name);
                MissedCount++;
                _log.LogWarning("{File} left the Passport folder before it could be copied (another program took it first).", name);
                return;
            case Outcome.Skip:
                _candidates.Remove(name);
                return;
            case Outcome.Failed:
                candidate.NextTry = now + TimeSpan.FromSeconds(5);
                _log.LogWarning("Could not copy {File} from the Passport folder: {Error}. Trying again.", name, error);
                return;
        }

        try
        {
            Directory.CreateDirectory(_paths.Inbox);
            File.Move(incoming, Path.Combine(_paths.Inbox, name), overwrite: true);
            _collected!.Add(name, now, "copied");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            candidate.NextTry = now + TimeSpan.FromSeconds(5);
            _log.LogError("Could not put {File} in {Inbox}: {Error}. Trying again.", name, _paths.Inbox, ex.Message);
            return;
        }
        _candidates.Remove(name);
        CopiedCount++;
        _onCopied?.Invoke();
        if (_delete) DeleteOriginal(name, source);
    }

    /// <summary>Copies the source to <paramref name="target"/> once nobody
    /// is writing it. Refusing other writers is the "Passport has finished"
    /// test: while Passport still holds the file for writing, opening it this
    /// way fails with a sharing violation. Readers and deleters (Modisoft)
    /// are not in the way.</summary>
    private static Outcome CopyWhole(string source, string target)
    {
        var info = new FileInfo(source);
        if (!info.Exists) throw new FileNotFoundException("Not in the folder any more.", source);
        // Hidden / system files are usually half-written temp files.
        if ((info.Attributes & (FileAttributes.Hidden | FileAttributes.System | FileAttributes.Directory)) != 0)
        {
            return Outcome.Skip;
        }
        using var from = new FileStream(source, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read | FileShare.Delete,
            Options = FileOptions.SequentialScan,
        });
        var length = from.Length;
        if (length == 0) return Outcome.Busy;
        using (var to = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            from.CopyTo(to);
            to.Flush(flushToDisk: true);
            if (to.Length != length) throw new IOException($"The copy has {to.Length:N0} of {length:N0} bytes.");
        }
        return Outcome.Copied;
    }

    private void DeleteOriginal(string name, string source)
    {
        try
        {
            PassportFolder.Wait(Task.Run(() =>
            {
                // A read-only original refuses to go; that is a "cannot".
                File.Delete(source);
                return true;
            }), DeleteTimeout, name);
            DeletedCount++;
            if (Problem.StartsWith("Could not delete", StringComparison.Ordinal))
            {
                Clear("Files are being deleted from the Passport folder again.");
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The copy is safe and goes to DineroBook either way; only the
            // tidy-up failed. Not tried again: the original stays.
            Report($"Could not delete {name} from the Passport folder ({ex.Message}). It was copied and will be sent; "
                   + $"check that this computer may change files in {_source}, or untick \"Delete files from XMLGateway\".",
                LogLevel.Warning);
        }
    }

    private void EnsureWatcher(DateTimeOffset now)
    {
        if (_watcherFor is null) return;
        if (_watcher is { Alive: true } && string.Equals(_watching, _source, StringComparison.OrdinalIgnoreCase)) return;
        if (_watcher is not null)
        {
            _log.LogWarning("The watcher on {Folder} stopped; making a new one (the folder is listed every poll meanwhile).", _watching);
            StopWatcher();
            // Whatever arrived while it was down is found by a listing now.
            _nextScanAt = DateTimeOffset.MinValue;
        }
        if (now < _nextWatcherTry) return;
        _nextWatcherTry = now + WatcherRetryEvery;
        _watcher = _watcherFor(_source);
        _watching = _source;
        _watcherSaw.Clear();
        _unreported.Clear();
        _watcherListed = false;
        // List at once: that listing is what was there before this watcher.
        _nextScanAt = DateTimeOffset.MinValue;
        if (_watcher is null)
        {
            _log.LogWarning("Could not watch {Folder} just now; listing it every poll and trying the watcher again in {Seconds} seconds.",
                _source, WatcherRetryEvery.TotalSeconds);
        }
        else
        {
            _log.LogInformation("Watching {Folder}: each file is copied to {Inbox} the moment it is complete.", _source, _paths.Inbox);
        }
    }

    private void StopWatcher()
    {
        _watcher?.Dispose();
        _watcher = null;
        _watching = "";
    }

    private bool OpenLedger()
    {
        if (_collected is not null) return true;
        try
        {
            Directory.CreateDirectory(_paths.Inbox);
            _collected = DailyLedger.Open(_paths.CollectedLedgers, _time.LocalTimeZone);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Report($"Cannot use the data folder {_paths.State}: {ex.Message}. Open DineroBook Manager and choose Install / Update.",
                LogLevel.Error);
            return false;
        }
    }

    private void Report(string message, LogLevel level)
    {
        Problem = message;
        var now = Now;
        // Log a problem when it starts or changes, then only now and then.
        if (_lastLogged is { } last && last.Message == message && now - last.At < RepeatProblemLogEvery) return;
        _lastLogged = (message, now);
        _log.Log(level, "{Message}", message);
    }

    private void Clear(string message)
    {
        Problem = "";
        _lastLogged = null;
        _log.LogInformation("{Message}", message);
    }

    public void Dispose() => StopWatcher();
}
