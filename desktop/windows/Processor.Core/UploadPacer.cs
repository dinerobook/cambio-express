namespace DineroBook.Processor;

/// <summary>
/// At most <c>limit</c> events in any <c>window</c>-long stretch of time.
/// </summary>
public sealed class RateWindow
{
    private readonly Queue<DateTimeOffset> _times = new();

    public RateWindow(int limit, TimeSpan window)
    {
        if (limit < 1) throw new ArgumentOutOfRangeException(nameof(limit));
        Limit = limit;
        Window = window;
    }

    public int Limit { get; }
    public TimeSpan Window { get; }

    /// <summary>How long until one more event fits (zero = now).</summary>
    public TimeSpan WaitBeforeNext(DateTimeOffset now)
    {
        Prune(now);
        if (_times.Count < Limit) return TimeSpan.Zero;
        // The oldest event that must leave the window before one more fits.
        var leaving = _times.ElementAt(_times.Count - Limit);
        var wait = leaving + Window - now;
        return wait > TimeSpan.Zero ? wait : TimeSpan.Zero;
    }

    public void Record(DateTimeOffset at)
    {
        _times.Enqueue(at);
        Prune(at);
    }

    public int CountIn(DateTimeOffset now)
    {
        Prune(now);
        return _times.Count;
    }

    private void Prune(DateTimeOffset now)
    {
        while (_times.Count > 0 && _times.Peek() <= now - Window)
        {
            _times.Dequeue();
        }
    }
}

/// <summary>
/// Keeps uploads under the server's "120/minute;6000/hour" with room to
/// spare. A token bucket: up to <see cref="Burst"/> uploads at once (the
/// files several registers write at the same moment go together), refilled
/// at 5,000 an hour; and never more than 100 in a minute or 5,000 in an hour
/// whatever the bucket says. A first run facing thousands of old files
/// simply takes hours; it never trips the limit, which would also block
/// "Test connection".
/// </summary>
public sealed class UploadPacer
{
    public const int Burst = 8;
    public const int PerMinute = 100;
    public const int PerHour = 5000;

    /// <summary>One token every 0.72 s: 5,000 an hour.</summary>
    public static readonly TimeSpan Refill = TimeSpan.FromMilliseconds(720);

    private readonly RateWindow _minute = new(PerMinute, TimeSpan.FromMinutes(1));
    private readonly RateWindow _hour = new(PerHour, TimeSpan.FromHours(1));
    private double _tokens = Burst;
    private DateTimeOffset? _filled;

    private void Fill(DateTimeOffset now)
    {
        if (_filled is { } then && now > then)
        {
            _tokens = Math.Min(Burst, _tokens + (now - then).Ticks / (double)Refill.Ticks);
        }
        if (_filled is null || now > _filled) _filled = now;
    }

    /// <summary>How long until one more upload may start (zero = now).</summary>
    public TimeSpan WaitBeforeNext(DateTimeOffset now)
    {
        Fill(now);
        var wait = _tokens >= 1 ? TimeSpan.Zero : TimeSpan.FromTicks((long)Math.Ceiling((1 - _tokens) * Refill.Ticks));
        var m = _minute.WaitBeforeNext(now);
        if (m > wait) wait = m;
        var h = _hour.WaitBeforeNext(now);
        if (h > wait) wait = h;
        return wait;
    }

    /// <summary>Counts one request sent at <paramref name="at"/>, whatever
    /// the server answered (the server counts refused ones too).</summary>
    public void Record(DateTimeOffset at)
    {
        Fill(at);
        _tokens = Math.Max(0, _tokens - 1);
        _minute.Record(at);
        _hour.Record(at);
    }

    public int SentInLastMinute(DateTimeOffset now) => _minute.CountIn(now);
    public int SentInLastHour(DateTimeOffset now) => _hour.CountIn(now);
}
