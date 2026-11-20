using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

public class FileNamesTests
{
    [Theory]
    [InlineData("PJR340251209133226277559.xml")]
    [InlineData("FGM1.xml")]
    [InlineData("PJR1.zip")]
    [InlineData("TransXML.zip")]
    [InlineData("notes.txt")]
    [InlineData("anything")]
    public void Every_file_goes(string name)
    {
        // Owner, 2026-11-18: "sari file bhejne gay" — no name or extension filter.
        Assert.True(FileNames.Sendable(name));
    }

    [Theory]
    [InlineData("")]
    [InlineData("PJR\t1.xml")]
    [InlineData("PJR\n1.xml")]
    public void Only_a_name_the_ledger_cannot_hold_is_left(string name)
    {
        Assert.False(FileNames.Sendable(name));
    }
}

public class ServiceFolderTests
{
    private sealed class Drives(Dictionary<string, string?> network) : IDriveMap
    {
        public bool IsNetworkDrive(string drive) => network.ContainsKey(drive);
        public string? ShareOf(string drive) => network.GetValueOrDefault(drive);
    }

    private static readonly Drives Z = new(new() { ["Z:"] = @"\\10.5.48.2\XMLGateway", ["Y:"] = null });

    [Fact]
    public void A_network_path_stays_as_it_is()
    {
        var r = ServiceFolder.Resolve(@" \\10.5.48.2\XMLGateway\BOOutBox ", Z);
        Assert.True(r.Ok);
        Assert.Equal(@"\\10.5.48.2\XMLGateway\BOOutBox", r.Path);
        Assert.Equal("", r.Note);
    }

    [Theory]
    [InlineData(@"Z:\BOOutBox", @"\\10.5.48.2\XMLGateway\BOOutBox")]
    [InlineData(@"z:\BOOutBox", @"\\10.5.48.2\XMLGateway\BOOutBox")]
    [InlineData(@"Z:\", @"\\10.5.48.2\XMLGateway")]
    [InlineData(@"Z:", @"\\10.5.48.2\XMLGateway")]
    public void A_mapped_drive_is_saved_as_its_network_path(string chosen, string saved)
    {
        // The service never sees the person's Z: (LdPosService review point 18).
        var r = ServiceFolder.Resolve(chosen, Z);
        Assert.True(r.Ok);
        Assert.Equal(saved, r.Path);
        Assert.Contains("network drive", r.Note);
    }

    [Fact]
    public void A_mapped_drive_whose_share_is_unknown_is_refused()
    {
        var r = ServiceFolder.Resolve(@"Y:\BOOutBox", Z);
        Assert.False(r.Ok);
        Assert.Contains(@"\\10.5.48.2\XMLGateway\BOOutBox", r.Problem);
    }

    [Fact]
    public void A_folder_on_this_computer_is_kept_with_a_note()
    {
        var r = ServiceFolder.Resolve(@"C:\Passport\XMLGateway\BOOutbox", Z);
        Assert.True(r.Ok);
        Assert.Equal(@"C:\Passport\XMLGateway\BOOutbox", r.Path);
        Assert.Contains("network share", r.Note);
    }
}

public class ShareTimeoutTests
{
    [Fact]
    public void A_call_that_does_not_answer_in_time_is_a_folder_timeout()
    {
        var never = new TaskCompletionSource<int>().Task;
        var ex = Assert.Throws<FolderTimeoutException>(() => PassportFolder.Wait(never, TimeSpan.FromMilliseconds(50), "The folder X"));
        Assert.Contains("The folder X did not answer", ex.Message);
        Assert.IsAssignableFrom<IOException>(ex);
    }

    [Fact]
    public void The_calls_own_error_comes_through_as_it_is()
    {
        var failed = Task.FromException<int>(new DirectoryNotFoundException("gone"));
        Assert.Throws<DirectoryNotFoundException>(() => PassportFolder.Wait(failed, TimeSpan.FromSeconds(5), "x"));
    }

    [Fact]
    public void An_answer_in_time_is_returned()
    {
        Assert.Equal(7, PassportFolder.Wait(Task.FromResult(7), TimeSpan.FromSeconds(5), "x"));
    }

    [Fact]
    public async Task A_file_read_that_does_not_answer_in_time_is_a_folder_timeout()
    {
        using var dir = new TempDir();
        File.WriteAllText(dir.File("PJR1.xml"), "<a/>");
        var folder = new PassportFolder(fileTimeout: TimeSpan.Zero);
        var file = folder.List(dir.Path).Single();
        // A zero time limit runs out before any read can finish.
        await Assert.ThrowsAnyAsync<IOException>(() => folder.ReadAsync(file, CancellationToken.None));
    }
}

public class FolderCheckTests
{
    [Fact]
    public void A_relative_path_asks_for_the_network_path()
    {
        var r = FolderCheck.Check("BOOutbox");
        Assert.False(r.Ok);
        Assert.Contains(@"\\10.5.48.2\XMLGateway\BOOutBox", r.Message);
    }

    [Fact]
    public void Counts_every_file_and_names_the_newest()
    {
        using var dir = new TempDir();
        File.WriteAllText(dir.File("PJR1.xml"), "<a/>");
        File.WriteAllText(dir.File("notes.txt"), "x");
        File.SetLastWriteTimeUtc(dir.File("notes.txt"), DateTime.UtcNow.AddMinutes(1));
        var r = FolderCheck.Check(dir.Path);
        Assert.True(r.Ok, r.Message);
        Assert.Equal(2, r.Files);
        Assert.Contains("notes.txt", r.Message);
    }

    [Fact]
    public void A_missing_folder_says_so()
    {
        var r = FolderCheck.Check(@"C:\no\such\folder\" + Guid.NewGuid());
        Assert.False(r.Ok);
        Assert.Contains("does not exist", r.Message);
    }
}

public class StabilityTests
{
    private static readonly DateTime T0 = new(2026, 11, 18, 10, 0, 0, DateTimeKind.Utc);
    private static readonly DateTimeOffset Now = new(2026, 11, 18, 12, 0, 0, TimeSpan.Zero);

    private static FileSnapshot F(string name, long length, DateTime? write = null) =>
        new(name, @"C:\x\" + name, length, write ?? T0);

    private static FileStage? StageOf(UploadScheduler s, string name) => s.Get(name)?.Stage;

    [Fact]
    public void A_file_is_ready_once_it_held_still_across_two_polls()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR1.xml", 100)], Now);
        Assert.Equal(FileStage.Settling, StageOf(s, "PJR1.xml"));
        s.Observe([F("PJR1.xml", 100)], Now);
        Assert.Equal(FileStage.Ready, StageOf(s, "PJR1.xml"));
    }

    [Fact]
    public void A_growing_file_waits()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR1.xml", 100)], Now);
        s.Observe([F("PJR1.xml", 200)], Now);
        Assert.Equal(FileStage.Settling, StageOf(s, "PJR1.xml"));
        s.Observe([F("PJR1.xml", 200)], Now);
        Assert.Equal(FileStage.Ready, StageOf(s, "PJR1.xml"));
    }

    [Fact]
    public void A_rewrite_of_the_same_size_waits()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR1.xml", 100, T0)], Now);
        s.Observe([F("PJR1.xml", 100, T0.AddSeconds(3))], Now);
        Assert.Equal(FileStage.Settling, StageOf(s, "PJR1.xml"));
    }

    [Fact]
    public void A_ready_file_that_changes_starts_over_and_its_day_is_read_again()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR1.xml", 100)], Now);
        s.Observe([F("PJR1.xml", 100)], Now);
        s.SetDay("PJR1.xml", BusinessDay.Of(new DateOnly(2026, 11, 17)), final: true);
        s.Observe([F("PJR1.xml", 150, T0.AddSeconds(9))], Now);
        Assert.Equal(FileStage.Settling, StageOf(s, "PJR1.xml"));
        Assert.Equal(DayKind.Unknown, s.Get("PJR1.xml")!.Day.Kind);
    }

    [Fact]
    public void An_empty_file_is_never_ready()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR1.xml", 0)], Now);
        s.Observe([F("PJR1.xml", 0)], Now);
        Assert.Equal(FileStage.Settling, StageOf(s, "PJR1.xml"));
        Assert.Empty(s.NeedDay(10));
    }

    [Fact]
    public void A_file_that_left_the_listing_is_forgotten()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR1.xml", 100)], Now);
        s.Observe([], Now);
        Assert.Null(s.Get("PJR1.xml"));
        s.Observe([F("PJR1.xml", 100)], Now);
        Assert.Equal(FileStage.Settling, StageOf(s, "PJR1.xml"));
    }

    [Fact]
    public void Unsettle_starts_one_file_over()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR1.xml", 100), F("PJR2.xml", 100)], Now);
        s.Observe([F("PJR1.xml", 100), F("PJR2.xml", 100)], Now);
        s.Unsettle("PJR1.xml");
        s.Observe([F("PJR1.xml", 100), F("PJR2.xml", 100)], Now);
        Assert.Equal(FileStage.Settling, StageOf(s, "PJR1.xml"));
        Assert.Equal(FileStage.Ready, StageOf(s, "PJR2.xml"));
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
    public async Task Reads_while_Passport_still_has_the_file_open_for_writing()
    {
        using var dir = new TempDir();
        var path = dir.File("PJR1.xml");
        File.WriteAllText(path, "<a/>");
        var folder = new PassportFolder();
        var snap = folder.List(dir.Path).Single();
        // Passport holding the file with write access, letting readers in.
        using var writer = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.Read);
        Assert.Equal("<a/>"u8.ToArray(), await folder.ReadAsync(snap, CancellationToken.None));
        Assert.Equal(DayKind.Undated, folder.ReadDay(snap, complete: true).Kind);
    }

    [Fact]
    public async Task A_file_still_being_written_lists_a_stale_size_and_is_not_read()
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
        var read = await folder.ReadAsync(snap, CancellationToken.None);
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
    public async Task A_file_that_changed_size_since_the_listing_is_not_read()
    {
        using var dir = new TempDir();
        var path = dir.File("PJR1.xml");
        File.WriteAllText(path, "<a/>");
        var folder = new PassportFolder();
        var snap = folder.List(dir.Path).Single();
        File.AppendAllText(path, "<b/>");
        Assert.Null(await folder.ReadAsync(snap, CancellationToken.None));
    }

    [Fact]
    public async Task Never_writes_to_the_folder()
    {
        using var dir = new TempDir();
        File.WriteAllText(dir.File("PJR1.xml"), "<a/>");
        var before = Directory.GetFileSystemEntries(dir.Path).Order().ToArray();
        var write = File.GetLastWriteTimeUtc(dir.File("PJR1.xml"));
        var folder = new PassportFolder();
        foreach (var f in folder.List(dir.Path))
        {
            folder.ReadDay(f, complete: true);
            await folder.ReadAsync(f, CancellationToken.None);
        }
        Assert.Equal(before, Directory.GetFileSystemEntries(dir.Path).Order().ToArray());
        Assert.Equal(write, File.GetLastWriteTimeUtc(dir.File("PJR1.xml")));
    }
}
