using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

/// <summary>
/// The business-day rules. The server books day D the moment any file of a
/// later day arrives (auto_commit_rolled_days), and a file arriving after its
/// day was booked is not added. So no file of a later day may go while a file
/// of an earlier day is still on its way.
/// </summary>
public class SchedulerTests
{
    private static readonly DateTime W0 = new(2026, 11, 17, 22, 50, 0, DateTimeKind.Utc);
    private static readonly DateTimeOffset Now = new(2026, 11, 18, 4, 0, 0, TimeSpan.Zero);
    private static readonly DateOnly D = new(2026, 11, 17);
    private static readonly DateOnly D1 = new(2026, 11, 18);

    private static FileSnapshot F(string name, int seconds = 0, long length = 100) =>
        new(name, @"C:\BOOutbox\" + name, length, W0.AddSeconds(seconds));

    /// <summary>Files seen on two polls (ready), each with its final day.</summary>
    private static UploadScheduler Ready(params (FileSnapshot File, BusinessDay Day)[] files)
    {
        var s = new UploadScheduler();
        var listing = files.Select(f => f.File).ToList();
        s.Observe(listing, Now);
        s.Observe(listing, Now);
        foreach (var (file, day) in files) s.SetDay(file.Name, day, final: true);
        return s;
    }

    private static string[] Names(IEnumerable<TrackedFile> files) => files.Select(f => f.Name).ToArray();

    [Fact]
    public void Files_of_the_oldest_day_go_together()
    {
        var s = Ready(
            (F("PJR-R1-a.xml", 1), BusinessDay.Of(D)),
            (F("PJR-R2-a.xml", 2), BusinessDay.Of(D)),
            (F("PJR-R3-a.xml", 3), BusinessDay.Of(D)),
            (F("PJR-R4-a.xml", 4), BusinessDay.Of(D)));
        Assert.Equal(["PJR-R1-a.xml", "PJR-R2-a.xml", "PJR-R3-a.xml", "PJR-R4-a.xml"], Names(s.NextToStart(Now, 4)));
        Assert.Equal(2, s.NextToStart(Now, 2).Count);
    }

    [Fact]
    public void Older_days_first_and_later_days_wait()
    {
        var s = Ready(
            (F("PJR-new.xml", 1), BusinessDay.Of(D1)),
            (F("PJR-old.xml", 9), BusinessDay.Of(D)));
        Assert.Equal(["PJR-old.xml"], Names(s.NextToStart(Now, 4)));
    }

    /// <summary>
    /// Day close with four registers: register 1's last sale of day D and the
    /// first sales of day D+1 on registers 2–4 are written at the same moment.
    /// D+1 must not go until register 1's D file is up, or day D is booked
    /// without its last sale.
    /// </summary>
    [Fact]
    public void The_day_rollover_race_with_four_registers()
    {
        var s = Ready(
            (F("PJR-R2-first.xml", 0), BusinessDay.Of(D1)),
            (F("PJR-R3-first.xml", 0), BusinessDay.Of(D1)),
            (F("PJR-R1-last.xml", 0), BusinessDay.Of(D)),
            (F("PJR-R4-first.xml", 0), BusinessDay.Of(D1)));

        var first = s.NextToStart(Now, 4);
        Assert.Equal(["PJR-R1-last.xml"], Names(first));
        s.Started(first[0]);

        // In flight (slow upload): still nothing of D+1.
        Assert.Empty(s.NextToStart(Now, 3));
        var held = s.HeldBy(Now);
        Assert.Equal("PJR-R1-last.xml", held!.Value.File.Name);
        Assert.Contains("being sent", held.Value.Why);

        // It fails once: still held, and named as the reason.
        s.Failed("PJR-R1-last.xml", "HTTP 500", Now.AddSeconds(5));
        Assert.Empty(s.NextToStart(Now, 4));
        Assert.Contains("retrying: HTTP 500", s.HeldBy(Now)!.Value.Why);

        // Its retry comes due: it goes again first, alone.
        Assert.Equal(["PJR-R1-last.xml"], Names(s.NextToStart(Now.AddSeconds(5), 4)));
        s.Started(s.Get("PJR-R1-last.xml")!);
        s.Done("PJR-R1-last.xml");

        // Day D is complete on the server's side: D+1 goes, all at once.
        Assert.Equal(["PJR-R2-first.xml", "PJR-R3-first.xml", "PJR-R4-first.xml"], Names(s.NextToStart(Now, 4)));
        Assert.Null(s.HeldBy(Now));
    }

    [Fact]
    public void A_file_of_the_older_day_still_being_written_holds_the_later_day()
    {
        var s = Ready(
            (F("PJR-R2-first.xml", 0), BusinessDay.Of(D1)),
            (F("PJR-R3-first.xml", 0), BusinessDay.Of(D1)));
        // Register 1's last D sale appears, still growing; its day is read
        // from what is there so far.
        s.Observe([F("PJR-R2-first.xml", 0), F("PJR-R3-first.xml", 0), F("PJR-R1-last.xml", 0, 40)], Now);
        s.SetDay("PJR-R1-last.xml", BusinessDay.Of(D), final: false);
        Assert.Empty(s.NextToStart(Now, 4));
        Assert.Contains("still being written", s.HeldBy(Now)!.Value.Why);

        // It holds still; its final day is read; it goes, then D+1.
        s.Observe([F("PJR-R2-first.xml", 0), F("PJR-R3-first.xml", 0), F("PJR-R1-last.xml", 0, 40)], Now);
        Assert.Empty(s.NextToStart(Now, 4)); // final day not read yet
        s.SetDay("PJR-R1-last.xml", BusinessDay.Of(D), final: true);
        Assert.Equal(["PJR-R1-last.xml"], Names(s.NextToStart(Now, 4)));
    }

    [Fact]
    public void A_file_whose_day_cannot_be_read_yet_holds_every_dated_file_for_a_while()
    {
        var s = Ready((F("PJR-a.xml", 0), BusinessDay.Of(D)));
        s.Observe([F("PJR-a.xml", 0), F("PJR-new.xml", 5, 12)], Now);
        // Too little of it written to see its day: it may be day D or older.
        Assert.Empty(s.NextToStart(Now, 4));
        Assert.Equal("PJR-new.xml", s.UnknownHolder(Now)!.Name);
        // A file that keeps changing for minutes stops holding others back.
        Assert.Equal(["PJR-a.xml"], Names(s.NextToStart(Now + UploadScheduler.UnknownHoldLimit, 4)));
    }

    [Fact]
    public void A_ready_file_whose_day_was_not_read_yet_holds_dated_files()
    {
        var s = Ready((F("PJR-a.xml", 0), BusinessDay.Of(D1)));
        s.Observe([F("PJR-a.xml", 0), F("PJR-b.xml", 9)], Now);
        s.Observe([F("PJR-a.xml", 0), F("PJR-b.xml", 9)], Now);
        Assert.Equal(["PJR-b.xml"], Names(s.NeedDay(10)));
        Assert.Empty(s.NextToStart(Now, 4));
        s.SetDay("PJR-b.xml", BusinessDay.Of(D), final: true);
        Assert.Equal(["PJR-b.xml"], Names(s.NextToStart(Now, 4)));
    }

    [Fact]
    public void Undated_files_go_in_name_order_with_no_barrier()
    {
        var s = Ready(
            (F("PJR-c.xml", 0), BusinessDay.Undated),
            (F("PJR-a.xml", 9), BusinessDay.Undated),
            (F("PJR-d1.xml", 0), BusinessDay.Of(D1)),
            (F("PJR-d.xml", 0), BusinessDay.Of(D)));
        s.Started(s.Get("PJR-d.xml")!); // day D busy: D+1 held...
        // ...the undated ones still go, by name.
        Assert.Equal(["PJR-a.xml", "PJR-c.xml"], Names(s.NextToStart(Now, 4)));
        // Even while a file's day cannot be read.
        s.Observe([F("PJR-c.xml", 0), F("PJR-a.xml", 9), F("PJR-d1.xml", 0), F("PJR-d.xml", 0), F("PJR-x.xml", 1, 10)], Now);
        Assert.Equal(["PJR-a.xml", "PJR-c.xml"], Names(s.NextToStart(Now, 4)));
    }

    [Fact]
    public void A_failing_file_never_holds_back_its_own_day()
    {
        var s = Ready(
            (F("PJR-R1.xml", 1), BusinessDay.Of(D)),
            (F("PJR-R2.xml", 2), BusinessDay.Of(D)),
            (F("PJR-R3.xml", 3), BusinessDay.Of(D1)));
        s.Started(s.Get("PJR-R1.xml")!);
        s.Failed("PJR-R1.xml", "HTTP 503", Now.AddMinutes(1));
        Assert.Equal(["PJR-R2.xml"], Names(s.NextToStart(Now, 4)));
        s.Started(s.Get("PJR-R2.xml")!);
        s.Done("PJR-R2.xml");
        Assert.Empty(s.NextToStart(Now, 4)); // R3 (D+1) waits for R1
        Assert.Equal(Now.AddMinutes(1), s.NextRetryAt);
        Assert.Equal("PJR-R1.xml", s.HeldBy(Now)!.Value.File.Name);
    }

    [Fact]
    public void A_file_requeued_after_a_pause_goes_again_without_a_failure()
    {
        var s = Ready((F("PJR-a.xml", 0), BusinessDay.Of(D)));
        s.Started(s.Get("PJR-a.xml")!);
        s.Requeue("PJR-a.xml");
        Assert.Equal(0, s.Get("PJR-a.xml")!.Failures);
        Assert.Equal(["PJR-a.xml"], Names(s.NextToStart(Now, 1)));
    }

    [Fact]
    public void A_file_being_sent_stays_until_it_is_done_even_if_it_leaves_the_folder()
    {
        var s = Ready((F("PJR-a.xml", 0), BusinessDay.Of(D)));
        s.Started(s.Get("PJR-a.xml")!);
        s.Observe([], Now);
        Assert.Equal(FileStage.InFlight, s.Get("PJR-a.xml")!.Stage);
        s.Done("PJR-a.xml");
        Assert.Equal(0, s.Count);
    }

    [Fact]
    public void Days_are_read_oldest_file_first_finished_files_before_growing_ones()
    {
        var s = new UploadScheduler();
        s.Observe([F("PJR-b.xml", 5), F("PJR-a.xml", 1)], Now);
        s.Observe([F("PJR-b.xml", 5), F("PJR-a.xml", 1), F("PJR-c.xml", 0)], Now);
        Assert.Equal(["PJR-a.xml", "PJR-b.xml", "PJR-c.xml"], Names(s.NeedDay(10)));
        Assert.Single(s.NeedDay(1));
    }
}
