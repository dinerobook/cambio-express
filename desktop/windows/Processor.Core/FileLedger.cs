using System.Globalization;
using System.Text;

namespace DineroBook.Processor;

/// <summary>
/// The files already dealt with, one per line:
/// <c>name &lt;TAB&gt; UTC time &lt;TAB&gt; outcome</c>. Append-only. Deleting the
/// file is safe: the server keeps one copy per filename, so a file sent again
/// comes back "duplicate". A line with no tab is a bare file name (the
/// Python agent's uploaded.txt format), so its list can be copied in.
/// </summary>
public sealed class FileLedger
{
    private readonly string _path;
    private readonly HashSet<string> _names = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<DateOnly, int> _perDay = new();
    private readonly TimeZoneInfo _zone;

    private FileLedger(string path, TimeZoneInfo zone)
    {
        _path = path;
        _zone = zone;
    }

    /// <summary>Reads the ledger. A missing file is an empty ledger.</summary>
    public static FileLedger Open(string path, TimeZoneInfo? zone = null)
    {
        var ledger = new FileLedger(path, zone ?? TimeZoneInfo.Local);
        var text = AtomicFile.TryReadShared(path);
        if (text is null) return ledger;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            var parts = line.Split('\t');
            var name = parts[0].Trim();
            if (name.Length == 0) continue;
            ledger._names.Add(name);
            if (parts.Length > 1
                && DateTimeOffset.TryParse(parts[1], CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var at))
            {
                ledger.CountDay(at);
            }
        }
        return ledger;
    }

    public int Count => _names.Count;

    public bool Contains(string name) => _names.Contains(name);

    /// <summary>Every name in the ledger.</summary>
    public IEnumerable<string> Names => _names;

    /// <summary>How many entries were added on this local day.</summary>
    public int CountOn(DateOnly localDay) => _perDay.GetValueOrDefault(localDay);

    /// <summary>Appends one entry and flushes it to disk before returning.</summary>
    public void Add(string name, DateTimeOffset at, string outcome)
    {
        if (name.Length == 0 || name.Any(char.IsControl))
        {
            throw new ArgumentException("A file name with control characters cannot go in the ledger.", nameof(name));
        }
        var safeOutcome = new string(outcome.Select(c => char.IsControl(c) ? ' ' : c).ToArray());
        var line = name + "\t"
            + at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)
            + "\t" + safeOutcome + "\r\n";
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        using (var fs = new FileStream(_path, FileMode.Append, FileAccess.Write,
                   FileShare.ReadWrite | FileShare.Delete))
        {
            var bytes = Encoding.UTF8.GetBytes(line);
            fs.Write(bytes, 0, bytes.Length);
            fs.Flush(flushToDisk: true);
        }
        _names.Add(name);
        CountDay(at);
    }

    private void CountDay(DateTimeOffset at)
    {
        var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(at, _zone).DateTime);
        _perDay[day] = _perDay.GetValueOrDefault(day) + 1;
    }
}
