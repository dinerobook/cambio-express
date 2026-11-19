namespace DineroBook.Processor;

/// <summary>
/// How long to wait after an answer that was not "done". Nothing here ever
/// drops a file or lets a newer file overtake it: every path ends in "try
/// the same file again later".
/// </summary>
public static class RetryPolicy
{
    /// <summary>After a failed try (5xx, network, odd answer), the wait
    /// before the next — the Python agent's 5 s, 15 s, 1 min, 5 min, then
    /// every 5 minutes. A success starts the ladder over.</summary>
    private static readonly TimeSpan[] Ladder =
    [
        TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15),
        TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5),
    ];

    /// <summary>After a 429. The server counts per minute and per hour.</summary>
    public static readonly TimeSpan RateLimitedPause = TimeSpan.FromMinutes(1);

    /// <summary>After the key or the store was refused, or the upload format
    /// was: nothing changes until a person acts, so look again every five
    /// minutes (and at once when a new key is saved).</summary>
    public static readonly TimeSpan BlockedPause = TimeSpan.FromMinutes(5);

    /// <summary>The same file failing this many times in a row is reported
    /// as an error ("stuck"), not a warning. It is still never skipped: the
    /// server books a business day as soon as a later day's file arrives,
    /// so letting the next file overtake it could book its day without it.</summary>
    public const int StuckAfter = 3;

    public static TimeSpan AfterFailures(int consecutiveFailures)
    {
        if (consecutiveFailures < 1) return TimeSpan.Zero;
        return Ladder[Math.Min(consecutiveFailures, Ladder.Length) - 1];
    }
}
