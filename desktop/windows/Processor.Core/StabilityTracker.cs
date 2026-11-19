namespace DineroBook.Processor;

/// <summary>One file in a folder listing: name, size and last write time,
/// as the listing itself reports them (no file is opened to get them).</summary>
public readonly record struct FileSnapshot(string Name, string FullPath, long Length, DateTime LastWriteUtc);

/// <summary>
/// Passport may still be writing a file when a poll first sees it. A file is
/// ready to send once its size and last write time are the same on two polls
/// in a row, and it is not empty. A file that changes starts over.
/// </summary>
public sealed class StabilityTracker
{
    private readonly Dictionary<string, (long Length, DateTime Write)> _seen =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Feeds one poll's listing (only the files still to send) and
    /// returns those that held still since the previous poll. Files missing
    /// from this listing are forgotten.</summary>
    public List<FileSnapshot> Observe(IReadOnlyCollection<FileSnapshot> files)
    {
        var ready = new List<FileSnapshot>();
        var present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in files)
        {
            present.Add(f.Name);
            if (_seen.TryGetValue(f.Name, out var prev)
                && prev.Length == f.Length
                && prev.Write == f.LastWriteUtc
                && f.Length > 0)
            {
                ready.Add(f);
            }
            _seen[f.Name] = (f.Length, f.LastWriteUtc);
        }
        if (present.Count != _seen.Count)
        {
            foreach (var gone in _seen.Keys.Where(k => !present.Contains(k)).ToList())
            {
                _seen.Remove(gone);
            }
        }
        return ready;
    }

    /// <summary>Starts a file over: it must hold still for two more polls.</summary>
    public void Forget(string name) => _seen.Remove(name);

    public void Reset() => _seen.Clear();

    public int Tracked => _seen.Count;
}
