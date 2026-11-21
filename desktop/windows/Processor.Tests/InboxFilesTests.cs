using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

/// <summary>
/// "Delete files from the temp folder": once DineroBook has a file, its
/// copy in this computer's temp folder is deleted (ticked, the default) or
/// moved to the archive, one folder a day (unticked).
/// </summary>
public class InboxFilesTests
{
    private static readonly DateTimeOffset At = new(2026, 11, 21, 3, 30, 0, TimeSpan.Zero);
    private static readonly TimeZoneInfo Central = TimeZoneInfo.FindSystemTimeZoneById("Central Standard Time");

    private static (TempDir Dir, DataPaths Paths, string Copy) Inbox(string name)
    {
        var dir = new TempDir();
        var paths = new DataPaths(dir.Path, isCustom: true);
        Directory.CreateDirectory(paths.Inbox);
        var copy = Path.Combine(paths.Inbox, name);
        File.WriteAllText(copy, "<x/>");
        return (dir, paths, copy);
    }

    [Fact]
    public void Ticked_the_copy_is_deleted()
    {
        var (dir, paths, copy) = Inbox("PJR001.xml");
        using (dir)
        {
            InboxFiles.Finish(paths, "PJR001.xml", delete: true, At, Central);

            Assert.False(File.Exists(copy));
            Assert.False(Directory.Exists(paths.Archive));
        }
    }

    [Fact]
    public void Unticked_the_copy_is_kept_in_the_archive_under_its_local_day()
    {
        var (dir, paths, copy) = Inbox("PJR002.xml");
        using (dir)
        {
            InboxFiles.Finish(paths, "PJR002.xml", delete: false, At, Central);

            Assert.False(File.Exists(copy), "the inbox keeps only files still to send");
            // 03:30 UTC on Nov 21 is 21:30 on Nov 20 in Austin.
            var kept = Path.Combine(paths.Archive, "2026-11-20", "PJR002.xml");
            Assert.True(File.Exists(kept));
            Assert.Equal("<x/>", File.ReadAllText(kept));
        }
    }

    [Fact]
    public void A_copy_already_gone_is_fine()
    {
        var (dir, paths, copy) = Inbox("PJR003.xml");
        using (dir)
        {
            File.Delete(copy);
            InboxFiles.Finish(paths, "PJR003.xml", delete: false, At, Central);
            InboxFiles.Finish(paths, "PJR003.xml", delete: true, At, Central);
        }
    }

    [Fact]
    public void Settings_delete_temp_copies_by_default_and_never_the_Passport_files()
    {
        var old = ProcessorSettings.Parse("""{ "apiUrl": "https://dinerobook.com" }""", out var problem);
        Assert.Equal("", problem);
        Assert.True(old.DeleteFromInbox);
        Assert.False(old.DeleteFromOutbox);

        var back = ProcessorSettings.Parse(new ProcessorSettings { DeleteFromInbox = false, DeleteFromOutbox = true }.ToJson(), out _);
        Assert.False(back.DeleteFromInbox);
        Assert.True(back.DeleteFromOutbox);
    }
}
