using System.Text.Json;
using DineroBook.Processor;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Processor.Tests;

/// <summary>An in-memory Passport folder.</summary>
internal sealed class FakeFolder : IPassportFolder
{
    public readonly Dictionary<string, (byte[] Content, DateTime Write)> Files = new(StringComparer.OrdinalIgnoreCase);
    public Exception? ListError;
    public Func<FileSnapshot, byte[]?>? ReadOverride;
    public Func<FileSnapshot, BusinessDay?>? DayOverride;

    public void Put(string name, string content, DateTime write) => Files[name] = (Naxml.Bytes(content), write);

    public IReadOnlyList<FileSnapshot> List(string folder)
    {
        if (ListError is not null) throw ListError;
        return Files.Select(kv => new FileSnapshot(kv.Key, Path.Combine(folder, kv.Key), kv.Value.Content.Length, kv.Value.Write)).ToList();
    }

    public BusinessDay ReadDay(FileSnapshot file, bool complete)
    {
        if (DayOverride?.Invoke(file) is { } day) return day;
        if (!Files.TryGetValue(file.Name, out var f)) throw new FileNotFoundException(file.Name);
        return BusinessDateReader.Read(f.Content, complete);
    }

    public Task<byte[]?> ReadAsync(FileSnapshot file, CancellationToken ct)
    {
        if (ReadOverride is not null) return Task.FromResult(ReadOverride(file));
        if (!Files.TryGetValue(file.Name, out var f)) throw new FileNotFoundException(file.Name);
        return Task.FromResult(f.Content.Length == file.Length ? f.Content : null);
    }
}

/// <summary>The server: answers each upload from a function, records them,
/// and can hold an upload open until the test lets it go.</summary>
internal sealed class FakeServer : IAgentUploader
{
    public readonly List<string> Uploads = new();
    public Func<string, UploadResult> Answer = _ => Ok();
    public readonly List<(Uri Api, string Key)> Created = new();
    public readonly Dictionary<string, TaskCompletionSource> Holds = new(StringComparer.OrdinalIgnoreCase);
    public int Open;
    public int MostOpen;

    public static UploadResult Ok(string outcome = "staged") => new(UploadVerdict.Accepted, 200, outcome,
        new AcceptedFile(outcome == "staged", outcome == "duplicate", "2026-11-17", outcome == "parse_error" ? "bad xml" : ""));

    public static UploadResult Status(int status, string body) => UploadAnswers.FromResponse(status, body);

    /// <summary>The next upload of this file stays open until Release.</summary>
    public void Hold(string name) => Holds[name] = new TaskCompletionSource();

    public void Release(string name) => Holds[name].SetResult();

    public async Task<UploadResult> UploadAsync(string fileName, byte[] content, CancellationToken ct)
    {
        Uploads.Add(fileName);
        Open++;
        MostOpen = Math.Max(MostOpen, Open);
        try
        {
            if (Holds.TryGetValue(fileName, out var gate)) await gate.Task;
            return Answer(fileName);
        }
        finally
        {
            Open--;
        }
    }

    public IAgentUploader For(Uri api, string key)
    {
        Created.Add((api, key));
        return this;
    }
}

internal sealed class FixedConfig : IConfigSource
{
    private bool _changed = true;
    private EngineConfig _cfg;

    public FixedConfig(EngineConfig cfg) => _cfg = cfg;

    public void Set(EngineConfig cfg)
    {
        _cfg = cfg;
        _changed = true;
    }

    public EngineConfig Current(out bool changed)
    {
        changed = _changed;
        _changed = false;
        return _cfg;
    }

    public static EngineConfig Running(string key = EngineTests.Key, string folder = @"C:\Passport\XMLGateway\BOOutbox", int parallel = 4) =>
        new(new ProcessorSettings { WatchFolder = folder, StoreName = "Main St", MaxConcurrentUploads = parallel },
            new Uri("https://dinerobook.com"), key, "", "");
}

public class EngineTests
{
    internal const string Key = "pak_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    private static readonly DateTime W0 = new(2026, 11, 17, 8, 0, 0, DateTimeKind.Utc);
    private const string D = "2026-11-17";
    private const string D1 = "2026-11-18";

    private sealed class Rig : IDisposable
    {
        public readonly TempDir Dir = new();
        public readonly ManualClock Clock = new(new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero));
        public readonly FakeFolder Folder = new();
        public readonly FakeServer Server = new();
        public readonly ListLogger Log = new();
        public readonly FixedConfig Config = new(FixedConfig.Running());
        public readonly List<string> StatusJson = new();
        public ProcessorEngine Engine;
        public DataPaths Paths;

        public Rig()
        {
            Paths = new DataPaths(Dir.Path, isCustom: true);
            Engine = NewEngine();
        }

        public ProcessorEngine NewEngine() => new(Paths, Config, Folder, Server.For, Clock, Log, "0.1.0",
            s => StatusJson.Add(JsonSerializer.Serialize(s)));

        /// <summary>One pass, then the wait it asked for.</summary>
        public async Task<TimeSpan> Cycle()
        {
            var wait = await Engine.RunCycleAsync(CancellationToken.None);
            Clock.Advance(wait);
            return wait;
        }

        /// <summary>Passes until the condition holds (or a simulated hour).</summary>
        public async Task Until(Func<bool> done)
        {
            var end = Clock.GetUtcNow().AddHours(1);
            while (!done() && Clock.GetUtcNow() < end) await Cycle();
            Assert.True(done(), "condition not reached");
        }

        public async Task Release(string name)
        {
            Server.Release(name);
            await Engine.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        }

        public void Dispose() => Dir.Dispose();
    }

    // ── The basics ──

    [Fact]
    public async Task Sends_a_file_once_it_held_still_across_two_polls_and_never_again()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        await rig.Cycle();
        Assert.Empty(rig.Server.Uploads);
        await rig.Cycle();
        Assert.Equal(["PJR1.xml"], rig.Server.Uploads);
        for (var i = 0; i < 4; i++) await rig.Cycle();
        Assert.Single(rig.Server.Uploads);
        Assert.Equal(1, rig.Engine.Status.SentTotal);
        Assert.Equal(1, rig.Engine.Status.TodayCount);
        Assert.Equal("staged", rig.Engine.Status.LastUploadResult);
        Assert.Equal(ProcessorState.Idle, rig.Engine.Status.State);
    }

    [Fact]
    public async Task A_restart_does_not_send_again()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        await rig.Cycle();
        await rig.Cycle();
        rig.Engine = rig.NewEngine();
        for (var i = 0; i < 4; i++) await rig.Cycle();
        Assert.Single(rig.Server.Uploads);
        Assert.Equal(1, rig.Engine.Status.TodayCount);
    }

    [Fact]
    public async Task Only_matching_files_go()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("MSM1.xml", Naxml.Movement("MiscellaneousSummaryMovement", D), W0.AddSeconds(1));
        rig.Folder.Put("PJR1.zip", "zip", W0);
        rig.Folder.Put("notes.txt", "x", W0);
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["MSM1.xml", "PJR1.xml"], rig.Server.Uploads.Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Older_business_days_go_first_whatever_the_name_or_time()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR-a.xml", Naxml.Sale(D1), W0);
        rig.Folder.Put("TPM-z.xml", Naxml.Movement("TankProductMovement", "2026-11-16"), W0.AddMinutes(5));
        rig.Folder.Put("PJR-m.xml", Naxml.Sale(D), W0.AddMinutes(2));
        await rig.Until(() => rig.Server.Uploads.Count == 3);
        Assert.Equal(["TPM-z.xml", "PJR-m.xml", "PJR-a.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task Duplicate_and_parse_error_count_as_sent()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0.AddSeconds(1));
        rig.Server.Answer = name => FakeServer.Ok(name == "PJR1.xml" ? "duplicate" : "parse_error");
        await rig.Until(() => rig.Engine.Status.SentTotal == 2);
        Assert.Contains("already on the server (duplicate)", rig.Log.All);
        Assert.Contains("parse_error: bad xml", rig.Log.All);
        Assert.Contains("PJR1.xml\t", File.ReadAllText(rig.Paths.SentLedger));
    }

    // ── Several at a time, day by day ──

    [Fact]
    public async Task Files_of_one_day_from_several_registers_go_at_once()
    {
        using var rig = new Rig();
        for (var r = 1; r <= 4; r++)
        {
            rig.Folder.Put($"PJR-R{r}.xml", Naxml.Sale(D, r.ToString()), W0.AddSeconds(r));
            rig.Server.Hold($"PJR-R{r}.xml");
        }
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(4, rig.Engine.UploadsInFlight);
        Assert.Equal(4, rig.Server.MostOpen);
        Assert.Equal(4, rig.Engine.Status.Uploading);
        for (var r = 1; r <= 4; r++) await rig.Release($"PJR-R{r}.xml");
        await rig.Cycle();
        Assert.Equal(4, rig.Engine.Status.SentTotal);
        Assert.Equal(0, rig.Engine.UploadsInFlight);
    }

    [Fact]
    public async Task No_more_than_the_configured_number_go_at_once()
    {
        using var rig = new Rig();
        rig.Config.Set(FixedConfig.Running(parallel: 2));
        for (var i = 1; i <= 6; i++)
        {
            rig.Folder.Put($"PJR{i}.xml", Naxml.Sale(D), W0.AddSeconds(i));
            rig.Server.Hold($"PJR{i}.xml");
        }
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(2, rig.Engine.UploadsInFlight);
        await rig.Release("PJR1.xml");
        await rig.Cycle();
        Assert.Equal(2, rig.Engine.UploadsInFlight);
        Assert.Equal(3, rig.Server.Uploads.Count);
        Assert.Equal(2, rig.Server.MostOpen);
    }

    /// <summary>
    /// Day close with four registers: register 1's last sale of day D and the
    /// first sales of D+1 on registers 2–4 land at the same moment, and
    /// register 1's upload is slow. Nothing of D+1 may reach the server before
    /// it, or the server books day D without that sale.
    /// </summary>
    [Fact]
    public async Task The_day_rollover_race_with_four_registers()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR-R2-0001.xml", Naxml.Sale(D1, "2"), W0);
        rig.Folder.Put("PJR-R3-0001.xml", Naxml.Sale(D1, "3"), W0);
        rig.Folder.Put("PJR-R4-0001.xml", Naxml.Sale(D1, "4"), W0);
        rig.Folder.Put("PJR-R1-9999.xml", Naxml.Sale(D, "1"), W0);
        foreach (var name in new[] { "PJR-R1-9999.xml", "PJR-R2-0001.xml", "PJR-R3-0001.xml", "PJR-R4-0001.xml" })
        {
            rig.Server.Hold(name);
        }
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR-R1-9999.xml"], rig.Server.Uploads);
        Assert.StartsWith("PJR-R1-9999.xml (business day 2026-11-17): being sent", rig.Engine.Status.WaitingOn);
        for (var i = 0; i < 6; i++) await rig.Cycle();
        Assert.Single(rig.Server.Uploads);

        // Register 1's file is accepted: day D+1's three go together.
        await rig.Release("PJR-R1-9999.xml");
        await rig.Cycle();
        Assert.Equal(1, rig.Engine.Status.SentTotal);
        Assert.Equal(3, rig.Engine.UploadsInFlight);
        Assert.Equal(["PJR-R2-0001.xml", "PJR-R3-0001.xml", "PJR-R4-0001.xml"], rig.Server.Uploads.Skip(1).Order());
        Assert.Equal("", rig.Engine.Status.WaitingOn);
    }

    [Fact]
    public async Task A_file_of_the_older_day_still_being_written_holds_the_later_day()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR-R2-0001.xml", Naxml.Sale(D1, "2"), W0);
        var full = Naxml.Sale(D, "1");
        var half = full[..(full.IndexOf("</BusinessDate>", StringComparison.Ordinal) + 15)];
        rig.Folder.Put("PJR-R1-9999.xml", half, W0);
        await rig.Cycle();
        // R2 holds still and is ready; R1 keeps growing.
        rig.Folder.Put("PJR-R1-9999.xml", full[..(half.Length + 20)], W0.AddSeconds(1));
        await rig.Cycle();
        rig.Folder.Put("PJR-R1-9999.xml", full[..(half.Length + 40)], W0.AddSeconds(2));
        await rig.Cycle();
        Assert.Empty(rig.Server.Uploads);
        Assert.Equal(FileStage.Ready, rig.Engine.Schedule.Get("PJR-R2-0001.xml")!.Stage);
        Assert.Contains("PJR-R1-9999.xml (business day 2026-11-17): still being written", rig.Engine.Status.WaitingOn);
        rig.Folder.Put("PJR-R1-9999.xml", full, W0.AddSeconds(3));
        await rig.Until(() => rig.Server.Uploads.Count == 2);
        Assert.Equal(["PJR-R1-9999.xml", "PJR-R2-0001.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task A_failing_file_holds_later_days_but_never_its_own()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR-R1.xml", Naxml.Sale(D, "1"), W0);
        rig.Folder.Put("PJR-R2.xml", Naxml.Sale(D, "2"), W0.AddSeconds(1));
        rig.Folder.Put("PJR-next.xml", Naxml.Sale(D1, "2"), W0.AddSeconds(2));
        rig.Server.Answer = name => name == "PJR-R1.xml" ? FakeServer.Status(500, "boom") : FakeServer.Ok();
        await rig.Cycle();
        await rig.Cycle();
        for (var i = 0; i < 30; i++) await rig.Cycle();
        // R2 (same day) went; the next day waits for R1, which keeps trying.
        Assert.Contains("PJR-R2.xml", rig.Server.Uploads);
        Assert.DoesNotContain("PJR-next.xml", rig.Server.Uploads);
        Assert.True(rig.Server.Uploads.Count(n => n == "PJR-R1.xml") >= 3);
        Assert.StartsWith("PJR-R1.xml (business day 2026-11-17): retrying: HTTP 500", rig.Engine.Status.WaitingOn);
        Assert.Contains(rig.Log.Lines, l => l.Level == LogLevel.Error && l.Message.Contains("Stuck on PJR-R1.xml"));

        rig.Server.Answer = _ => FakeServer.Ok();
        await rig.Until(() => rig.Engine.Status.SentTotal == 3);
        Assert.Equal("PJR-next.xml", rig.Server.Uploads[^1]);
    }

    /// <summary>Two uploads colliding on the server roll back to a 5xx; the
    /// retry then finds the file already staged.</summary>
    [Fact]
    public async Task A_500_once_then_duplicate_counts_as_sent()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        var calls = 0;
        rig.Server.Answer = _ => ++calls == 1
            ? FakeServer.Status(500, """{"detail":"Internal Server Error"}""")
            : FakeServer.Ok("duplicate");
        await rig.Until(() => rig.Engine.Status.SentTotal == 1);
        Assert.Equal(2, calls);
        Assert.Equal("duplicate", rig.Engine.Status.LastUploadResult);
        Assert.Equal(0, rig.Engine.Status.SkippedTotal);
        Assert.Contains("PJR1.xml\t", File.ReadAllText(rig.Paths.SentLedger));
    }

    [Fact]
    public async Task Undated_files_go_without_waiting_for_any_day()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR-d.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR-d1.xml", Naxml.Sale(D1), W0);
        rig.Folder.Put("PJR-junk-b.xml", "not xml", W0);
        rig.Folder.Put("PJR-junk-a.xml", "<html/>", W0.AddSeconds(5));
        rig.Server.Hold("PJR-d.xml");
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR-d.xml", "PJR-junk-a.xml", "PJR-junk-b.xml"], rig.Server.Uploads);
        Assert.DoesNotContain("PJR-d1.xml", rig.Server.Uploads);
    }

    [Fact]
    public async Task The_bytes_sent_decide_the_day()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR-old.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR-x.xml", Naxml.Sale(D1), W0.AddSeconds(1));
        // A first look got PJR-x's day wrong (said D).
        rig.Folder.DayOverride = f => f.Name == "PJR-x.xml" ? BusinessDay.Of(new DateOnly(2026, 11, 17)) : null;
        rig.Server.Hold("PJR-old.xml");
        await rig.Cycle();
        await rig.Cycle();
        // PJR-x was picked as day D but its bytes say D+1: not sent.
        Assert.Equal(["PJR-old.xml"], rig.Server.Uploads);
        Assert.Equal(DayKind.Dated, rig.Engine.Schedule.Get("PJR-x.xml")!.Day.Kind);
        Assert.Equal(new DateOnly(2026, 11, 18), rig.Engine.Schedule.Get("PJR-x.xml")!.Day.Date);
        await rig.Release("PJR-old.xml");
        await rig.Until(() => rig.Server.Uploads.Count == 2);
        Assert.Equal("PJR-x.xml", rig.Server.Uploads[1]);
    }

    // ── Answers that stop sending ──

    [Fact]
    public async Task A_refused_key_stops_sending_until_a_new_key_is_saved()
    {
        using var rig = new Rig();
        rig.Config.Set(FixedConfig.Running(parallel: 1));
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0.AddSeconds(1));
        rig.Server.Answer = _ => FakeServer.Status(401, """{"detail":"Invalid agent key."}""");
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR1.xml"], rig.Server.Uploads);
        Assert.Equal(ProcessorState.KeyRejected, rig.Engine.Status.State);
        Assert.Contains("Sign in again", rig.Engine.Status.Message);
        Assert.False(File.Exists(rig.Paths.SentLedger) && File.ReadAllText(rig.Paths.SentLedger).Contains("PJR1"));

        for (var i = 0; i < 6; i++) await rig.Cycle();
        Assert.Single(rig.Server.Uploads);

        // "Sign in again" saves a new key: sending resumes at once.
        rig.Server.Answer = _ => FakeServer.Ok();
        rig.Config.Set(FixedConfig.Running("pak_NEWKEY_0123456789abcdefghijklmnopqrstuvw", parallel: 1));
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR1.xml", "PJR1.xml", "PJR2.xml"], rig.Server.Uploads);
        Assert.Equal("pak_NEWKEY_0123456789abcdefghijklmnopqrstuvw", rig.Server.Created.Last().Key);
    }

    [Fact]
    public async Task A_refused_key_is_retried_every_five_minutes_and_logged_once()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        var times = new List<DateTimeOffset>();
        rig.Server.Answer = _ =>
        {
            times.Add(rig.Clock.GetUtcNow());
            return FakeServer.Status(401, "{}");
        };
        await rig.Until(() => times.Count >= 3);
        Assert.Equal(TimeSpan.FromMinutes(5), times[1] - times[0]);
        Assert.Equal(TimeSpan.FromMinutes(5), times[2] - times[1]);
        Assert.Single(rig.Log.Lines, l => l.Level == LogLevel.Error);
    }

    [Theory]
    [InlineData(402, """{"detail":"This store's subscription has lapsed.","reason":"subscription"}""")]
    [InlineData(403, """{"detail":"This store has been disabled. Contact support.","reason":"store_disabled"}""")]
    public async Task A_closed_store_keeps_the_files_and_waits(int status, string body)
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Server.Answer = _ => FakeServer.Status(status, body);
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(ProcessorState.StoreClosed, rig.Engine.Status.State);
        Assert.Contains(JsonDocument.Parse(body).RootElement.GetProperty("detail").GetString()!, rig.Engine.Status.Message);
        rig.Server.Answer = _ => FakeServer.Ok();
        await rig.Until(() => rig.Engine.Status.SentTotal == 1);
        Assert.Equal(["PJR1.xml", "PJR1.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task A_422_skips_that_file_for_good_and_the_rest_carry_on()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0.AddSeconds(1));
        rig.Server.Answer = name => name == "PJR1.xml" ? FakeServer.Status(422, """{"detail":"Filename is required."}""") : FakeServer.Ok();
        await rig.Until(() => rig.Engine.Status.SkippedTotal == 1 && rig.Engine.Status.SentTotal == 1);
        for (var i = 0; i < 3; i++) await rig.Cycle();
        Assert.Equal(2, rig.Server.Uploads.Count);
        Assert.Contains("Filename is required.", File.ReadAllText(rig.Paths.SkippedLedger));
    }

    [Fact]
    public async Task A_422_from_the_request_check_skips_nothing_and_asks_for_an_update()
    {
        using var rig = new Rig();
        rig.Config.Set(FixedConfig.Running(parallel: 1));
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0.AddSeconds(1));
        rig.Server.Answer = _ => FakeServer.Status(422, """{"detail":[{"loc":["body","x"],"msg":"Field required"}]}""");
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(ProcessorState.UpdateNeeded, rig.Engine.Status.State);
        Assert.Equal(0, rig.Engine.Status.SkippedTotal);
        Assert.Equal(["PJR1.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task A_429_pauses_a_minute()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        var times = new List<DateTimeOffset>();
        rig.Server.Answer = _ =>
        {
            times.Add(rig.Clock.GetUtcNow());
            return times.Count == 1
                ? FakeServer.Status(429, """{"detail":"Too many requests — try again in a moment."}""")
                : FakeServer.Ok();
        };
        await rig.Until(() => times.Count == 2);
        Assert.Equal(TimeSpan.FromMinutes(1), times[1] - times[0]);
        Assert.Equal(1, rig.Engine.Status.SentTotal);
    }

    [Fact]
    public async Task One_file_failing_backs_off_on_the_ladder()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        var tries = new List<DateTimeOffset>();
        rig.Server.Answer = _ =>
        {
            tries.Add(rig.Clock.GetUtcNow());
            return FakeServer.Status(500, "boom");
        };
        await rig.Until(() => tries.Count >= 6);
        var gaps = tries.Zip(tries.Skip(1), (a, b) => b - a).ToList();
        Assert.Equal(
            [TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15), TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5)],
            gaps);
        Assert.Equal(0, rig.Engine.Status.SentTotal);
        Assert.Equal(0, rig.Engine.Status.SkippedTotal);
    }

    [Fact]
    public async Task When_everything_fails_it_sends_one_at_a_time_and_recovers()
    {
        using var rig = new Rig();
        for (var i = 1; i <= 12; i++) rig.Folder.Put($"PJR{i:D2}.xml", Naxml.Sale(D), W0.AddSeconds(i));
        rig.Server.Answer = _ => UploadAnswers.FromException(new HttpRequestException("No such host is known."));
        await rig.Cycle();
        for (var i = 0; i < 40; i++) await rig.Cycle();
        var during = rig.Server.Uploads.Count;
        // An outage: a few tries, then one at a time on the ladder.
        Assert.InRange(during, ProcessorEngine.OutageStreak, 30);
        Assert.Equal(0, rig.Engine.Status.SentTotal);
        Assert.Equal(12, rig.Engine.Status.Waiting);
        rig.Server.Answer = _ => FakeServer.Ok();
        await rig.Until(() => rig.Engine.Status.SentTotal == 12);
        Assert.Contains("going through again", rig.Log.All);
    }

    [Fact]
    public async Task Too_large_or_too_long_a_name_is_skipped_without_sending()
    {
        using var rig = new Rig();
        var big = Naxml.Sale(D).Replace("<TransactionDetailGroup>", "<TransactionDetailGroup><Pad>" + new string('x', ServerContract.MaxFileBytes) + "</Pad>");
        rig.Folder.Put("PJR1.xml", big, W0);
        rig.Folder.Put("PJR" + new string('9', 120) + ".xml", Naxml.Sale(D), W0.AddSeconds(1));
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0.AddSeconds(2));
        await rig.Until(() => rig.Engine.Status.SkippedTotal == 2 && rig.Engine.Status.SentTotal == 1);
        Assert.Equal(["PJR2.xml"], rig.Server.Uploads);
        var skipped = File.ReadAllText(rig.Paths.SkippedLedger);
        Assert.Contains("too_large", skipped);
        Assert.Contains("name_too_long", skipped);
    }

    [Fact]
    public async Task A_file_that_changed_while_being_read_settles_again()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        var reads = 0;
        rig.Folder.ReadOverride = f => ++reads == 1 ? null : rig.Folder.Files[f.Name].Content;
        await rig.Cycle();
        await rig.Cycle();
        Assert.Empty(rig.Server.Uploads);
        await rig.Until(() => rig.Server.Uploads.Count == 1);
        Assert.Equal(1, rig.Engine.Status.SentTotal);
    }

    [Fact]
    public async Task A_file_removed_before_it_was_read_is_let_go()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0.AddSeconds(1));
        rig.Folder.ReadOverride = f => f.Name == "PJR1.xml" ? throw new FileNotFoundException() : rig.Folder.Files[f.Name].Content;
        await rig.Until(() => rig.Engine.Status.SentTotal == 1);
        Assert.Equal(["PJR2.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task A_missing_folder_is_reported_then_recovers()
    {
        using var rig = new Rig();
        rig.Folder.ListError = new DirectoryNotFoundException("Could not find a part of the path.");
        await rig.Cycle();
        Assert.Equal(ProcessorState.FolderUnavailable, rig.Engine.Status.State);
        Assert.Contains(@"C:\Passport\XMLGateway\BOOutbox", rig.Engine.Status.Message);
        rig.Folder.ListError = null;
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        await rig.Until(() => rig.Server.Uploads.Count == 1);
    }

    [Fact]
    public async Task Without_a_key_it_waits_and_says_so()
    {
        using var rig = new Rig();
        rig.Config.Set(new EngineConfig(new ProcessorSettings(), new Uri("https://dinerobook.com"), null,
            ProcessorState.NotSignedIn, "Not signed in."));
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        var wait = await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(ProcessorEngine.RecheckEvery, wait);
        Assert.Empty(rig.Server.Uploads);
        Assert.Equal(ProcessorState.NotSignedIn, rig.Engine.Status.State);
    }

    [Fact]
    public async Task A_backlog_is_paced_under_the_servers_limit_day_by_day()
    {
        using var rig = new Rig();
        for (var i = 0; i < 400; i++)
        {
            var day = new DateOnly(2026, 11, 1).AddDays(i / 100).ToString("yyyy-MM-dd");
            rig.Folder.Put($"PJR{i:D5}.xml", Naxml.Sale(day), W0.AddSeconds(i));
        }
        var start = rig.Clock.GetUtcNow();
        var sent = new List<(DateTimeOffset At, string Name)>();
        rig.Server.Answer = name =>
        {
            sent.Add((rig.Clock.GetUtcNow(), name));
            return FakeServer.Ok();
        };
        await rig.Until(() => rig.Engine.Status.SentTotal == 400);
        Assert.Equal(400, sent.Count);
        // Every file of a day before any file of the next.
        var days = sent.Select(s => int.Parse(s.Name[3..8]) / 100).ToList();
        Assert.Equal(days.Order(), days);
        for (var i = 0; i < sent.Count; i++)
        {
            Assert.True(sent.Skip(i).TakeWhile(t => t.At < sent[i].At.AddMinutes(1)).Count() <= UploadPacer.PerMinute);
        }
        Assert.InRange(rig.Clock.GetUtcNow() - start, TimeSpan.FromMinutes(4.4), TimeSpan.FromMinutes(6));
    }

    [Fact]
    public async Task The_key_never_reaches_the_status_or_the_log()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0.AddSeconds(1));
        var n = 0;
        rig.Server.Answer = _ => ++n switch
        {
            1 => FakeServer.Status(401, "{}"),
            2 => FakeServer.Status(500, "x"),
            _ => FakeServer.Ok(),
        };
        for (var i = 0; i < 80; i++) await rig.Cycle();
        await rig.Engine.DrainAsync(TimeSpan.FromSeconds(1));
        rig.Engine.Stopped();
        Assert.NotEmpty(rig.StatusJson);
        Assert.All(rig.StatusJson, s => Assert.DoesNotContain("pak_", s));
        Assert.DoesNotContain("pak_", rig.Log.All);
        Assert.Equal(ProcessorState.Stopped, rig.Engine.Status.State);
        Assert.False(rig.Engine.Status.Running);
    }

    [Fact]
    public async Task Writes_status_json_for_the_manager()
    {
        using var rig = new Rig();
        rig.Engine = new ProcessorEngine(rig.Paths, rig.Config, rig.Folder, rig.Server.For, rig.Clock, rig.Log, "0.1.0");
        rig.Folder.Put("PJR1.xml", Naxml.Sale(D), W0);
        rig.Folder.Put("PJR2.xml", Naxml.Sale(D), W0);
        await rig.Until(() => rig.Engine.Status.SentTotal == 2);
        var status = ProcessorStatus.TryRead(rig.Paths.Status)!;
        Assert.True(status.Running);
        Assert.Equal(2, status.TodayCount);
        Assert.Equal(0, status.Waiting);
        Assert.Equal(0, status.Uploading);
        Assert.Equal("", status.WaitingOn);
        Assert.Equal("Main St", status.StoreName);
        Assert.Equal("https://dinerobook.com", status.ApiUrl);
        Assert.Equal("0.1.0", status.Version);
    }
}
