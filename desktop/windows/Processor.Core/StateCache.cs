namespace DineroBook.Processor;

/// <summary>
/// The "Clear cache" button (DineroBook Manager → Setup → 3): the lists of
/// files already copied, sent or refused — <c>state\sent.txt</c>,
/// <c>state\skipped.txt</c> and every <c>state\collected\*.txt</c>.
/// <list type="bullet">
/// <item>They only grow (a busy store writes about 2,000 files a day), and
/// the service reads them all into memory at start.</item>
/// <item>Clearing them is safe: DineroBook keeps one copy per file name, so a
/// file still in BOOutbox or the temp folder that goes again comes back
/// "duplicate" and is never counted twice.</item>
/// <item>Nothing else is touched: settings, the key, the logs, the temp
/// folder with files still to send, and the archive all stay.</item>
/// </list>
/// Clear with the service stopped: it holds the lists in memory and would
/// write them back.
/// </summary>
public static class StateCache
{
    /// <summary>How many list files there are, and their size on disk.</summary>
    public sealed record Summary(int Files, long Bytes)
    {
        public string Describe() => Files == 0
            ? "empty"
            : $"{Size(Bytes)} in {Files} file{(Files == 1 ? "" : "s")}";

        private static string Size(long bytes) => bytes switch
        {
            < 1024 => $"{bytes} bytes",
            < 1024 * 1024 => $"{bytes / 1024.0:0.#} KB",
            < 1024L * 1024 * 1024 => $"{bytes / (1024.0 * 1024):0.#} MB",
            _ => $"{bytes / (1024.0 * 1024 * 1024):0.##} GB",
        };
    }

    /// <summary>The list files that exist now.</summary>
    public static IReadOnlyList<string> Files(DataPaths paths)
    {
        var files = new List<string>();
        foreach (var single in new[] { paths.SentLedger, paths.SkippedLedger, LegacyCollected(paths) })
        {
            if (File.Exists(single)) files.Add(single);
        }
        if (Directory.Exists(paths.CollectedLedgers))
        {
            files.AddRange(Directory.EnumerateFiles(paths.CollectedLedgers, "*.txt"));
        }
        return files;
    }

    public static Summary Measure(DataPaths paths)
    {
        var files = Files(paths);
        long bytes = 0;
        foreach (var f in files)
        {
            try
            {
                bytes += new FileInfo(f).Length;
            }
            catch (IOException)
            {
                // Gone meanwhile.
            }
        }
        return new Summary(files.Count, bytes);
    }

    /// <summary>Deletes every list file. Returns what was there.</summary>
    /// <exception cref="IOException">A file could not be deleted (the
    /// service still running holds it); the ones before it are gone.</exception>
    public static Summary Clear(DataPaths paths)
    {
        var before = Measure(paths);
        foreach (var f in Files(paths))
        {
            File.Delete(f);
        }
        return before;
    }

    /// <summary>The one-file list an earlier build kept, before it became one
    /// file a day.</summary>
    private static string LegacyCollected(DataPaths paths) => Path.Combine(paths.State, "collected.txt");
}
