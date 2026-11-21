using System.Globalization;

namespace DineroBook.Processor;

/// <summary>
/// A ledger kept as one file per local day — <c>state\collected\2026-11-20.txt</c>
/// — so no single file grows forever (owner, 2026-11-20). Each file has the
/// <see cref="FileLedger"/> line format (name, UTC time, outcome).
/// <see cref="Contains"/> answers for every day: all the day files are read
/// when it opens (a name is a few dozen bytes; a busy store writes a few
/// hundred thousand a year). Old days may be deleted by hand: a file named
/// in a deleted day would be copied again, and the server answers
/// "duplicate".
/// </summary>
public sealed class DailyLedger
{
    private readonly string _folder;
    private readonly TimeZoneInfo _zone;
    private readonly HashSet<string> _names = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<DateOnly, FileLedger> _days = new();

    private DailyLedger(string folder, TimeZoneInfo zone)
    {
        _folder = folder;
        _zone = zone;
    }

    /// <summary>Reads every day file in <paramref name="folder"/>. A
    /// missing folder is an empty ledger.</summary>
    public static DailyLedger Open(string folder, TimeZoneInfo zone)
    {
        var ledger = new DailyLedger(folder, zone);
        if (!Directory.Exists(folder)) return ledger;
        foreach (var path in Directory.EnumerateFiles(folder, "*.txt"))
        {
            var one = FileLedger.Open(path, zone);
            foreach (var name in one.Names) ledger._names.Add(name);
        }
        return ledger;
    }

    public int Count => _names.Count;

    public bool Contains(string name) => _names.Contains(name);

    /// <summary>The file a name added at <paramref name="at"/> goes in.</summary>
    public string PathFor(DateTimeOffset at) => Path.Combine(_folder, Day(at).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + ".txt");

    /// <summary>Appends to that local day's file and flushes it to disk.</summary>
    public void Add(string name, DateTimeOffset at, string outcome)
    {
        var day = Day(at);
        if (!_days.TryGetValue(day, out var ledger))
        {
            Directory.CreateDirectory(_folder);
            ledger = FileLedger.Open(PathFor(at), _zone);
            _days[day] = ledger;
        }
        ledger.Add(name, at, outcome);
        _names.Add(name);
    }

    private DateOnly Day(DateTimeOffset at) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, _zone).DateTime);
}
