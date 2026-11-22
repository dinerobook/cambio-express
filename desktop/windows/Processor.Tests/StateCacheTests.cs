using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

/// <summary>
/// <see cref="StateCache"/>, the Manager's "Clear cache" button: it empties
/// the lists of files already copied, sent or refused, and nothing else.
/// </summary>
public class StateCacheTests
{
    private static void Write(string path, string text = "PJR001.xml\t2026-11-20T15:00:00Z\tstaged\n")
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
    }

    [Fact]
    public void It_clears_every_list_and_leaves_everything_else()
    {
        using var dir = new TempDir();
        var paths = new DataPaths(dir.Path, isCustom: true);
        Write(paths.SentLedger);
        Write(paths.SkippedLedger);
        Write(Path.Combine(paths.CollectedLedgers, "2026-11-19.txt"));
        Write(Path.Combine(paths.CollectedLedgers, "2026-11-20.txt"));
        Write(Path.Combine(paths.State, "collected.txt")); // an earlier build's one file
        // What must stay.
        Write(paths.Settings, "{}");
        Write(paths.AgentKey, "key");
        Write(paths.Status, "{}");
        Write(Path.Combine(paths.Logs, "processor-2026-11-20.log"), "log");
        Write(Path.Combine(paths.Inbox, "PJR002.xml"), "<x/>");
        Write(Path.Combine(paths.Archive, "2026-11-20", "PJR001.xml"), "<x/>");

        var before = StateCache.Measure(paths);
        var cleared = StateCache.Clear(paths);

        Assert.Equal(5, before.Files);
        Assert.Equal(before, cleared);
        Assert.Equal(new StateCache.Summary(0, 0), StateCache.Measure(paths));
        Assert.False(File.Exists(paths.SentLedger));
        Assert.Empty(Directory.GetFiles(paths.CollectedLedgers));
        Assert.True(File.Exists(paths.Settings));
        Assert.True(File.Exists(paths.AgentKey));
        Assert.True(File.Exists(paths.Status));
        Assert.True(File.Exists(Path.Combine(paths.Logs, "processor-2026-11-20.log")));
        Assert.True(File.Exists(Path.Combine(paths.Inbox, "PJR002.xml")), "a file still to send stays");
        Assert.True(File.Exists(Path.Combine(paths.Archive, "2026-11-20", "PJR001.xml")));
    }

    [Fact]
    public void An_empty_cache_is_fine()
    {
        using var dir = new TempDir();
        var paths = new DataPaths(dir.Path, isCustom: true);

        Assert.Equal(new StateCache.Summary(0, 0), StateCache.Clear(paths));
        Assert.Equal("empty", StateCache.Measure(paths).Describe());
    }

    [Fact]
    public void After_a_clear_the_ledgers_start_again_and_a_file_is_copied_once_more()
    {
        using var dir = new TempDir();
        var paths = new DataPaths(dir.Path, isCustom: true);
        var zone = TimeZoneInfo.Utc;
        var at = new DateTimeOffset(2026, 11, 20, 15, 0, 0, TimeSpan.Zero);
        DailyLedger.Open(paths.CollectedLedgers, zone).Add("PJR001.xml", at, "copied");
        FileLedger.Open(paths.SentLedger, zone).Add("PJR001.xml", at, "staged");

        StateCache.Clear(paths);

        Assert.False(DailyLedger.Open(paths.CollectedLedgers, zone).Contains("PJR001.xml"));
        Assert.False(FileLedger.Open(paths.SentLedger, zone).Contains("PJR001.xml"));
    }

    [Theory]
    [InlineData(0, 0, "empty")]
    [InlineData(1, 900, "900 bytes in 1 file")]
    [InlineData(3, 1536, "1.5 KB in 3 files")]
    [InlineData(400, 150L * 1024 * 1024, "150 MB in 400 files")]
    public void The_size_reads_plainly(int files, long bytes, string expected)
    {
        Assert.Equal(expected, new StateCache.Summary(files, bytes).Describe());
    }
}
