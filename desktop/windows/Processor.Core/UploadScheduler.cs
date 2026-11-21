namespace DineroBook.Processor;

/// <summary>Where a file is on its way up.</summary>
public enum FileStage
{
    /// <summary>Seen, but not yet the same size and time on two polls.</summary>
    Settling,

    /// <summary>Held still; may go when its business day's turn comes.</summary>
    Ready,

    /// <summary>Being read and sent now.</summary>
    InFlight,

    /// <summary>A try failed; tried again at <see cref="TrackedFile.NextTryAt"/>.</summary>
    Retrying,
}

/// <summary>One file still to send.</summary>
public sealed class TrackedFile
{
    internal TrackedFile(FileSnapshot snap, DateTimeOffset now)
    {
        Snapshot = snap;
        FirstSeen = now;
    }

    public FileSnapshot Snapshot { get; internal set; }
    public string Name => Snapshot.Name;
    public FileStage Stage { get; internal set; } = FileStage.Settling;
    public BusinessDay Day { get; internal set; } = BusinessDay.Unknown;

    /// <summary>The day was read from the finished file (not a guess from
    /// a file still being written).</summary>
    public bool DayFinal { get; internal set; }

    public DateTimeOffset FirstSeen { get; }
    public int Failures { get; internal set; }
    public DateTimeOffset NextTryAt { get; internal set; }
    public string LastError { get; internal set; } = "";
}

/// <summary>
/// Which files may be sent now. The rules, from the server's day booking
/// (<c>auto_commit_rolled_days</c> books day D as soon as any file with a
/// later business date arrives, and a file that arrives after its day was
/// booked is not added):
/// <list type="number">
/// <item>older business days first;</item>
/// <item>files of the same business day go in parallel;</item>
/// <item>no file of a later day goes while any file of an earlier day is
/// still settling, ready, in flight or retrying — a failing file holds
/// later days back (and is named in the status);</item>
/// <item>a file with no business day goes in file name order, with no
/// barrier;</item>
/// <item>while a file still being written cannot be dated yet, no dated
/// file goes (it might be the older day), for at most
/// <see cref="UnknownHoldLimit"/>.</item>
/// </list>
/// Those rules hold only with <c>inOrder: true</c> (a folder read directly).
/// From the service's inbox (<c>inOrder: false</c>) every file is whole when
/// it lands, so each goes at once in the order it came, with no day order and
/// no waiting on another file (owner, 2026-11-20): the server works out a day
/// from the events' own start and end times.
/// Pure bookkeeping: the engine does the reading and sending.
/// <para>
/// The service runs it with <c>inOrder: false</c> (owner, 2026-11-20): it
/// sends from its own inbox, where every file is already whole, so a file
/// is ready the moment it is listed and goes at once, in the order the
/// files arrived — no business-day order, no waiting on another file. The
/// server puts each file in its tables as it comes and works out a day from
/// the events' own start and end times.
/// </para>
/// </summary>
public sealed class UploadScheduler(bool inOrder = true)
{
    /// <summary>False: every file goes as soon as it is listed (the
    /// service's inbox).</summary>
    public bool InOrder { get; } = inOrder;

    /// <summary>How long a file still being written, whose day cannot be
    /// read yet, holds dated files back.</summary>
    public static readonly TimeSpan UnknownHoldLimit = TimeSpan.FromMinutes(2);

    private readonly Dictionary<string, TrackedFile> _files = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyCollection<TrackedFile> Files => _files.Values;

    public TrackedFile? Get(string name) => _files.GetValueOrDefault(name);

    public int Count => _files.Count;
    public int InFlight => _files.Values.Count(f => f.Stage == FileStage.InFlight);

    /// <summary>One poll's listing of the files still to send. New files
    /// start settling; a file that held still is ready; a file that changed
    /// starts over; a file that left the folder is forgotten (unless it is
    /// being sent, which settles it).</summary>
    public void Observe(IReadOnlyCollection<FileSnapshot> listing, DateTimeOffset now)
    {
        var present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var snap in listing)
        {
            present.Add(snap.Name);
            if (!_files.TryGetValue(snap.Name, out var f))
            {
                var added = new TrackedFile(snap, now);
                // A whole file in the inbox: ready at once.
                if (!InOrder && snap.Length > 0) added.Stage = FileStage.Ready;
                _files[snap.Name] = added;
                continue;
            }
            if (f.Stage == FileStage.InFlight) continue;
            var same = f.Snapshot.Length == snap.Length && f.Snapshot.LastWriteUtc == snap.LastWriteUtc;
            if (!same)
            {
                f.Snapshot = snap;
                f.Stage = FileStage.Settling;
                if (f.DayFinal)
                {
                    // Rewritten: read its day again.
                    f.DayFinal = false;
                    f.Day = BusinessDay.Unknown;
                }
                continue;
            }
            if (f.Stage == FileStage.Settling && snap.Length > 0) f.Stage = FileStage.Ready;
        }
        foreach (var gone in _files.Values.Where(f => f.Stage != FileStage.InFlight && !present.Contains(f.Name)).Select(f => f.Name).ToList())
        {
            _files.Remove(gone);
        }
    }

    /// <summary>Files whose day should be read now: ready ones without a
    /// final day first (oldest first), then settling ones still unknown.</summary>
    public IReadOnlyList<TrackedFile> NeedDay(int max) => !InOrder ? [] :
        _files.Values
            .Where(f => f.Snapshot.Length > 0
                        && ((f.Stage is FileStage.Ready or FileStage.Retrying && !f.DayFinal)
                            || (f.Stage == FileStage.Settling && f.Day.Kind == DayKind.Unknown)))
            .OrderBy(f => f.Stage == FileStage.Settling ? 1 : 0)
            .ThenBy(f => f.Snapshot.LastWriteUtc)
            .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
            .Take(max)
            .ToList();

    /// <summary>Records a file's day. <paramref name="final"/>: read from
    /// the finished file.</summary>
    public void SetDay(string name, BusinessDay day, bool final)
    {
        if (!_files.TryGetValue(name, out var f)) return;
        f.Day = day;
        f.DayFinal = final && day.Kind != DayKind.Unknown;
        if (f.DayFinal) f.LastError = "";
    }

    /// <summary>The file could not be opened to read its day; it is tried
    /// again on the next pass and holds dated files back meanwhile.</summary>
    public void DayUnreadable(string name, string error)
    {
        if (_files.TryGetValue(name, out var f)) f.LastError = error;
    }

    /// <summary>The oldest business day still on its way, if any.</summary>
    public DateOnly? OldestDay =>
        _files.Values.Where(f => f.Day.Kind == DayKind.Dated).Select(f => (DateOnly?)f.Day.Date).Min();

    /// <summary>A file still being written whose day is not known yet,
    /// or a finished one whose day has not been read yet: dated files wait.</summary>
    public TrackedFile? UnknownHolder(DateTimeOffset now) =>
        _files.Values
            .Where(f => f.Snapshot.Length > 0 && f.Day.Kind == DayKind.Unknown
                        && (f.Stage != FileStage.Settling || now - f.FirstSeen < UnknownHoldLimit))
            .OrderBy(f => f.Snapshot.LastWriteUtc)
            .FirstOrDefault();

    /// <summary>The files to start now, at most <paramref name="slots"/>.</summary>
    public IReadOnlyList<TrackedFile> NextToStart(DateTimeOffset now, int slots)
    {
        if (slots <= 0) return [];
        bool Due(TrackedFile f) => f.Stage == FileStage.Ready || (f.Stage == FileStage.Retrying && f.NextTryAt <= now);
        if (!InOrder)
        {
            // As they came: the oldest file first, every one due now.
            return _files.Values.Where(Due)
                .OrderBy(f => f.Snapshot.LastWriteUtc)
                .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase)
                .Take(slots)
                .ToList();
        }

        var list = new List<TrackedFile>();
        var oldest = OldestDay;
        if (oldest is { } day && UnknownHolder(now) is null)
        {
            list.AddRange(_files.Values
                .Where(f => f.Day.Kind == DayKind.Dated && f.DayFinal && f.Day.Date == day && Due(f))
                .OrderBy(f => f.Snapshot.LastWriteUtc)
                .ThenBy(f => f.Name, StringComparer.OrdinalIgnoreCase));
        }
        list.AddRange(_files.Values
            .Where(f => f.Day.Kind == DayKind.Undated && f.DayFinal && Due(f))
            .OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase));
        return list.Take(slots).ToList();
    }

    /// <summary>When something not due now becomes due (a retry), if ever.</summary>
    public DateTimeOffset? NextRetryAt =>
        _files.Values.Where(f => f.Stage == FileStage.Retrying).Select(f => (DateTimeOffset?)f.NextTryAt).Min();

    /// <summary>Why later business days are waiting, for the status: the
    /// file of the oldest day that is holding them, or null when nothing of
    /// a later day is waiting.</summary>
    public (TrackedFile File, string Why)? HeldBy(DateTimeOffset now)
    {
        if (!InOrder) return null;
        var oldest = OldestDay;
        var later = oldest is { } d && _files.Values.Any(f => f.Day.Kind == DayKind.Dated && f.Day.Date > d && f.Stage != FileStage.InFlight);
        if (UnknownHolder(now) is { } u && (later || oldest is not null))
        {
            return (u, u.Stage == FileStage.Settling
                ? "still being written"
                : "reading its business date" + (u.LastError.Length > 0 ? ": " + u.LastError : ""));
        }
        if (!later) return null;
        var group = _files.Values.Where(f => f.Day.Kind == DayKind.Dated && f.Day.Date == oldest).ToList();
        var holder = group.Where(f => f.Stage == FileStage.Retrying).OrderBy(f => f.Snapshot.LastWriteUtc).FirstOrDefault()
                     ?? group.Where(f => f.Stage == FileStage.Settling).OrderBy(f => f.Snapshot.LastWriteUtc).FirstOrDefault()
                     ?? group.Where(f => f.Stage == FileStage.InFlight).OrderBy(f => f.Snapshot.LastWriteUtc).FirstOrDefault()
                     ?? group.OrderBy(f => f.Snapshot.LastWriteUtc).FirstOrDefault();
        if (holder is null) return null;
        var why = holder.Stage switch
        {
            FileStage.Retrying => "retrying: " + holder.LastError,
            FileStage.Settling => "still being written",
            FileStage.InFlight => "being sent",
            _ => "queued",
        };
        return (holder, why);
    }

    // ── What happened to a file ──

    public void Started(TrackedFile f) => f.Stage = FileStage.InFlight;

    /// <summary>Sent (or refused for good): it leaves the schedule.</summary>
    public void Done(string name) => _files.Remove(name);

    /// <summary>Not tried (the store or key was refused, the server asked
    /// to slow down, it changed day): ready again, no failure counted.</summary>
    public void Requeue(string name)
    {
        if (_files.TryGetValue(name, out var f)) f.Stage = FileStage.Ready;
    }

    /// <summary>Changed or locked while being read: it settles again.</summary>
    public void Unsettle(string name)
    {
        if (!_files.TryGetValue(name, out var f)) return;
        f.Stage = FileStage.Settling;
        f.Snapshot = f.Snapshot with { Length = -1 };
        f.DayFinal = false;
    }

    /// <summary>A try failed: retry at <paramref name="at"/>.</summary>
    public void Failed(string name, string error, DateTimeOffset at)
    {
        if (!_files.TryGetValue(name, out var f)) return;
        f.Failures++;
        f.LastError = error;
        f.NextTryAt = at;
        f.Stage = FileStage.Retrying;
    }

    /// <summary>The file is no longer in the folder.</summary>
    public void Gone(string name) => _files.Remove(name);

    /// <summary>Everything starts over (a new Passport folder).</summary>
    public void Reset() => _files.Clear();
}
