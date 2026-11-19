using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

public class FilePatternsTests
{
    private static readonly FilePatterns Default = new(ProcessorSettings.DefaultPatterns);

    [Theory]
    [InlineData("PJR340251209133226277559.xml")]
    [InlineData("FGM340251209133226277559.xml")]
    [InlineData("ISM1.xml")]
    [InlineData("MCM1.xml")]
    [InlineData("MSM1.xml")]
    [InlineData("TLM1.xml")]
    [InlineData("TPM1.xml")]
    [InlineData("pjr1.XML")]
    [InlineData("PJR.xml")]
    public void Sends_the_journal_and_every_movement_report(string name)
    {
        Assert.True(Default.Matches(name));
    }

    [Theory]
    [InlineData("PJR1.zip")]
    [InlineData("TransXML.zip")]
    [InlineData("PJR1.xml.tmp")]
    [InlineData("PJR1.xmlold")]
    [InlineData("XPJR1.xml")]
    [InlineData("ABC1.xml")]
    [InlineData("")]
    [InlineData("PJR\t1.xml")]
    public void Leaves_everything_else(string name)
    {
        Assert.False(Default.Matches(name));
    }

    [Fact]
    public void The_default_list_is_the_python_agents()
    {
        Assert.Equal(
            ["PJR*.xml", "FGM*.xml", "ISM*.xml", "MCM*.xml", "MSM*.xml", "TLM*.xml", "TPM*.xml"],
            ProcessorSettings.DefaultPatterns);
    }

    [Fact]
    public void A_question_mark_is_one_character()
    {
        var p = new FilePatterns(["PJR?.xml"]);
        Assert.True(p.Matches("PJR1.xml"));
        Assert.False(p.Matches("PJR12.xml"));
    }
}

public class StabilityTrackerTests
{
    private static readonly DateTime T0 = new(2026, 11, 18, 10, 0, 0, DateTimeKind.Utc);

    private static FileSnapshot F(string name, long length, DateTime? write = null) =>
        new(name, @"C:\x\" + name, length, write ?? T0);

    [Fact]
    public void A_file_is_ready_once_it_held_still_across_two_polls()
    {
        var t = new StabilityTracker();
        Assert.Empty(t.Observe([F("PJR1.xml", 100)]));
        Assert.Single(t.Observe([F("PJR1.xml", 100)]));
    }

    [Fact]
    public void A_growing_file_waits()
    {
        var t = new StabilityTracker();
        t.Observe([F("PJR1.xml", 100)]);
        Assert.Empty(t.Observe([F("PJR1.xml", 200)]));
        Assert.Single(t.Observe([F("PJR1.xml", 200)]));
    }

    [Fact]
    public void A_rewrite_of_the_same_size_waits()
    {
        var t = new StabilityTracker();
        t.Observe([F("PJR1.xml", 100, T0)]);
        Assert.Empty(t.Observe([F("PJR1.xml", 100, T0.AddSeconds(3))]));
    }

    [Fact]
    public void An_empty_file_is_never_ready()
    {
        var t = new StabilityTracker();
        t.Observe([F("PJR1.xml", 0)]);
        Assert.Empty(t.Observe([F("PJR1.xml", 0)]));
    }

    [Fact]
    public void A_file_that_left_the_listing_starts_over()
    {
        var t = new StabilityTracker();
        t.Observe([F("PJR1.xml", 100)]);
        t.Observe([]);
        Assert.Empty(t.Observe([F("PJR1.xml", 100)]));
        Assert.Equal(1, t.Tracked);
    }

    [Fact]
    public void Forget_starts_one_file_over()
    {
        var t = new StabilityTracker();
        t.Observe([F("PJR1.xml", 100), F("PJR2.xml", 100)]);
        t.Forget("PJR1.xml");
        var ready = t.Observe([F("PJR1.xml", 100), F("PJR2.xml", 100)]);
        Assert.Equal(["PJR2.xml"], ready.Select(f => f.Name));
    }
}

public class FileLedgerTests
{
    private static readonly DateTimeOffset At = new(2026, 11, 18, 15, 30, 0, TimeSpan.Zero);

    [Fact]
    public void Remembers_across_a_restart()
    {
        using var dir = new TempDir();
        var path = dir.File("sent.txt");
        var ledger = FileLedger.Open(path, TimeZoneInfo.Utc);
        Assert.False(ledger.Contains("PJR1.xml"));
        ledger.Add("PJR1.xml", At, "staged");
        ledger.Add("PJR2.xml", At, "duplicate");

        var again = FileLedger.Open(path, TimeZoneInfo.Utc);
        Assert.True(again.Contains("PJR1.xml"));
        Assert.True(again.Contains("pjr2.XML"));
        Assert.Equal(2, again.Count);
        Assert.Equal("PJR1.xml\t2026-11-18T15:30:00Z\tstaged", File.ReadAllLines(path)[0]);
    }

    [Fact]
    public void A_missing_ledger_is_empty_and_deleting_it_is_safe()
    {
        using var dir = new TempDir();
        var path = dir.File("state/sent.txt");
        var ledger = FileLedger.Open(path, TimeZoneInfo.Utc);
        Assert.Equal(0, ledger.Count);
        ledger.Add("PJR1.xml", At, "staged");
        File.Delete(path);
        Assert.Equal(0, FileLedger.Open(path, TimeZoneInfo.Utc).Count);
    }

    [Fact]
    public void Reads_the_python_agents_uploaded_txt()
    {
        using var dir = new TempDir();
        var path = dir.File("sent.txt");
        File.WriteAllText(path, "PJR1.xml\nPJR2.xml\r\n\r\n");
        var ledger = FileLedger.Open(path, TimeZoneInfo.Utc);
        Assert.Equal(2, ledger.Count);
        Assert.True(ledger.Contains("PJR2.xml"));
    }

    [Fact]
    public void Counts_entries_per_local_day()
    {
        using var dir = new TempDir();
        var path = dir.File("sent.txt");
        // 03:00 UTC on the 19th is still the 18th in New York.
        var ny = TimeZoneInfo.CreateCustomTimeZone("ny", TimeSpan.FromHours(-5), "ny", "ny");
        var ledger = FileLedger.Open(path, ny);
        ledger.Add("PJR1.xml", new DateTimeOffset(2026, 11, 19, 3, 0, 0, TimeSpan.Zero), "staged");
        ledger.Add("PJR2.xml", new DateTimeOffset(2026, 11, 19, 6, 0, 0, TimeSpan.Zero), "staged");
        var again = FileLedger.Open(path, ny);
        Assert.Equal(1, again.CountOn(new DateOnly(2026, 11, 18)));
        Assert.Equal(1, again.CountOn(new DateOnly(2026, 11, 19)));
    }

    [Fact]
    public void Refuses_a_name_that_would_break_the_line_format()
    {
        using var dir = new TempDir();
        var ledger = FileLedger.Open(dir.File("sent.txt"), TimeZoneInfo.Utc);
        Assert.Throws<ArgumentException>(() => ledger.Add("PJR\n1.xml", At, "staged"));
    }
}

public class PassportFolderTests
{
    [Fact]
    public void Lists_files_only_with_their_size()
    {
        using var dir = new TempDir();
        File.WriteAllText(dir.File("PJR1.xml"), "<a/>");
        Directory.CreateDirectory(dir.File("sub"));
        File.WriteAllText(dir.File("sub/PJR2.xml"), "<a/>");
        var listed = new PassportFolder().List(dir.Path);
        var only = Assert.Single(listed);
        Assert.Equal("PJR1.xml", only.Name);
        Assert.Equal(4, only.Length);
    }

    [Fact]
    public void A_missing_folder_throws_so_the_status_can_say_so()
    {
        Assert.Throws<DirectoryNotFoundException>(() => new PassportFolder().List(@"C:\no\such\folder\" + Guid.NewGuid()));
    }

    [Fact]
    public void Reads_while_Passport_still_has_the_file_open_for_writing()
    {
        using var dir = new TempDir();
        var path = dir.File("PJR1.xml");
        File.WriteAllText(path, "<a/>");
        var folder = new PassportFolder();
        var snap = folder.List(dir.Path).Single();
        // Passport holding the file with write access, letting readers in.
        using var writer = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.Read);
        Assert.Equal("<a/>"u8.ToArray(), folder.Read(snap));
    }

    [Fact]
    public void A_file_still_being_written_lists_a_stale_size_and_is_not_read()
    {
        using var dir = new TempDir();
        var path = dir.File("PJR1.xml");
        using var writer = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read);
        writer.Write("<a/>"u8);
        writer.Flush();
        var folder = new PassportFolder();
        var snap = folder.List(dir.Path).Single();
        // NTFS updates the listed size when the writer closes the file, so
        // the listing and the open file can disagree: then it is not ready.
        // Whatever comes back always matches the listing.
        var read = folder.Read(snap);
        Assert.True(read is null ? snap.Length != 4 : read.Length == snap.Length);
    }

    [Fact]
    public void Never_locks_the_file_others_may_rename_or_delete_it_while_it_is_open()
    {
        using var dir = new TempDir();
        var path = dir.File("PJR1.xml");
        File.WriteAllText(path, "<a/>");
        using (PassportFolder.OpenForRead(path))
        {
            // Another back-office program moving or appending to the file.
            using (var other = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete))
            {
                other.Seek(0, SeekOrigin.End);
                other.Write("x"u8);
            }
            File.Move(path, dir.File("PJR1.moved"));
            File.Delete(dir.File("PJR1.moved"));
        }
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void A_file_that_changed_size_since_the_listing_is_not_read()
    {
        using var dir = new TempDir();
        var path = dir.File("PJR1.xml");
        File.WriteAllText(path, "<a/>");
        var folder = new PassportFolder();
        var snap = folder.List(dir.Path).Single();
        File.AppendAllText(path, "<b/>");
        Assert.Null(folder.Read(snap));
    }

    [Fact]
    public void Never_writes_to_the_folder()
    {
        using var dir = new TempDir();
        File.WriteAllText(dir.File("PJR1.xml"), "<a/>");
        var before = Directory.GetFileSystemEntries(dir.Path).Order().ToArray();
        var write = File.GetLastWriteTimeUtc(dir.File("PJR1.xml"));
        var folder = new PassportFolder();
        foreach (var f in folder.List(dir.Path)) folder.Read(f);
        Assert.Equal(before, Directory.GetFileSystemEntries(dir.Path).Order().ToArray());
        Assert.Equal(write, File.GetLastWriteTimeUtc(dir.File("PJR1.xml")));
    }
}
