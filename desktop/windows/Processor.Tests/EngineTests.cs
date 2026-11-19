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
    public int Reads;

    public void Put(string name, string content, DateTime write) =>
        Files[name] = (System.Text.Encoding.UTF8.GetBytes(content), write);

    public IReadOnlyList<FileSnapshot> List(string folder)
    {
        if (ListError is not null) throw ListError;
        return Files.Select(kv => new FileSnapshot(kv.Key, Path.Combine(folder, kv.Key), kv.Value.Content.Length, kv.Value.Write)).ToList();
    }

    public byte[]? Read(FileSnapshot file)
    {
        Reads++;
        if (ReadOverride is not null) return ReadOverride(file);
        if (!Files.TryGetValue(file.Name, out var f)) throw new FileNotFoundException(file.Name);
        return f.Content.Length == file.Length ? f.Content : null;
    }
}

/// <summary>The server: answers each upload from a function, records them.</summary>
internal sealed class FakeServer : IAgentUploader
{
    public readonly List<string> Uploads = new();
    public Func<string, UploadResult> Answer = _ => Ok();
    public readonly List<(Uri Api, string Key)> Created = new();

    public static UploadResult Ok(string outcome = "staged") => new(UploadVerdict.Accepted, 200, outcome,
        new AcceptedFile(outcome == "staged", outcome == "duplicate", "2026-11-17", outcome == "parse_error" ? "bad xml" : ""));

    public static UploadResult Status(int status, string body) => UploadAnswers.FromResponse(status, body);

    public Task<UploadResult> UploadAsync(string fileName, byte[] content, CancellationToken ct)
    {
        Uploads.Add(fileName);
        return Task.FromResult(Answer(fileName));
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

    public static EngineConfig Running(string key = EngineTests.Key, string folder = @"C:\Passport\XMLGateway\BOOutbox") =>
        new(new ProcessorSettings { WatchFolder = folder, StoreName = "Main St" }, new Uri("https://dinerobook.com"), key, "", "");
}

public class EngineTests
{
    internal const string Key = "pak_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    private static readonly DateTime W0 = new(2026, 11, 17, 8, 0, 0, DateTimeKind.Utc);

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
            Clock.Delay, s => StatusJson.Add(JsonSerializer.Serialize(s)));

        /// <summary>One cycle, then the wait it asked for.</summary>
        public async Task<TimeSpan> Cycle()
        {
            var wait = await Engine.RunCycleAsync(CancellationToken.None);
            Clock.Advance(wait);
            return wait;
        }

        public void Dispose() => Dir.Dispose();
    }

    [Fact]
    public async Task Sends_a_file_once_it_held_still_across_two_polls_and_never_again()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        await rig.Cycle();
        Assert.Empty(rig.Server.Uploads);
        await rig.Cycle();
        Assert.Equal(["PJR1.xml"], rig.Server.Uploads);
        await rig.Cycle();
        await rig.Cycle();
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
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        await rig.Cycle();
        await rig.Cycle();
        rig.Engine = rig.NewEngine();
        await rig.Cycle();
        await rig.Cycle();
        Assert.Single(rig.Server.Uploads);
        Assert.Equal(1, rig.Engine.Status.TodayCount);
    }

    [Fact]
    public async Task Only_matching_files_go()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("MSM1.xml", "<a/>", W0.AddSeconds(1));
        rig.Folder.Put("PJR1.zip", "zip", W0);
        rig.Folder.Put("notes.txt", "x", W0);
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR1.xml", "MSM1.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task Oldest_first_by_write_time_whatever_the_name()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR3.xml", "<c/>", W0.AddMinutes(2));
        rig.Folder.Put("FGM9.xml", "<b/>", W0.AddMinutes(1));
        rig.Folder.Put("TPM1.xml", "<a/>", W0);
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["TPM1.xml", "FGM9.xml", "PJR3.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task Duplicate_and_parse_error_count_as_sent()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
        rig.Server.Answer = name => FakeServer.Ok(name == "PJR1.xml" ? "duplicate" : "parse_error");
        await rig.Cycle();
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(2, rig.Server.Uploads.Count);
        Assert.Contains("already on the server (duplicate)", rig.Log.All);
        Assert.Contains("parse_error: bad xml", rig.Log.All);
        Assert.Contains("PJR1.xml\t", File.ReadAllText(rig.Paths.SentLedger));
    }

    [Fact]
    public async Task A_refused_key_stops_sending_until_a_new_key_is_saved()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
        rig.Server.Answer = _ => FakeServer.Status(401, """{"detail":"Invalid agent key."}""");
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR1.xml"], rig.Server.Uploads);
        Assert.Equal(ProcessorState.KeyRejected, rig.Engine.Status.State);
        Assert.Contains("Sign in again", rig.Engine.Status.Message);
        Assert.False(File.Exists(rig.Paths.SentLedger) && File.ReadAllText(rig.Paths.SentLedger).Contains("PJR1"));

        // Paused: a minute later nothing more has been tried.
        for (var i = 0; i < 6; i++) await rig.Cycle();
        Assert.Single(rig.Server.Uploads);

        // "Sign in again" saves a new key: sending resumes at once.
        rig.Server.Answer = _ => FakeServer.Ok();
        rig.Config.Set(FixedConfig.Running("pak_NEWKEY_0123456789abcdefghijklmnopqrstuvw"));
        await rig.Cycle();
        Assert.Equal(["PJR1.xml", "PJR1.xml", "PJR2.xml"], rig.Server.Uploads);
        Assert.Equal("pak_NEWKEY_0123456789abcdefghijklmnopqrstuvw", rig.Server.Created.Last().Key);
    }

    [Fact]
    public async Task A_refused_key_is_retried_every_five_minutes()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        var times = new List<DateTimeOffset>();
        rig.Server.Answer = _ =>
        {
            times.Add(rig.Clock.GetUtcNow());
            return FakeServer.Status(401, "{}");
        };
        await rig.Cycle();
        while (times.Count < 3) await rig.Cycle();
        Assert.Equal(TimeSpan.FromMinutes(5), times[1] - times[0]);
        Assert.Equal(TimeSpan.FromMinutes(5), times[2] - times[1]);
        // The Event Log gets the problem once, not every five minutes.
        Assert.Single(rig.Log.Lines, l => l.Level == LogLevel.Error);
    }

    [Theory]
    [InlineData(402, """{"detail":"This store's subscription has lapsed.","reason":"subscription"}""")]
    [InlineData(403, """{"detail":"This store has been disabled. Contact support.","reason":"store_disabled"}""")]
    public async Task A_closed_store_keeps_the_files_and_waits(int status, string body)
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Server.Answer = _ => FakeServer.Status(status, body);
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(ProcessorState.StoreClosed, rig.Engine.Status.State);
        Assert.Contains(JsonDocument.Parse(body).RootElement.GetProperty("detail").GetString()!, rig.Engine.Status.Message);
        rig.Server.Answer = _ => FakeServer.Ok();
        rig.Clock.Advance(TimeSpan.FromMinutes(5));
        await rig.Cycle();
        Assert.Equal(["PJR1.xml", "PJR1.xml"], rig.Server.Uploads);
        Assert.Equal(1, rig.Engine.Status.SentTotal);
    }

    [Fact]
    public async Task A_422_skips_that_file_for_good_and_the_rest_carry_on()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
        rig.Server.Answer = name => name == "PJR1.xml" ? FakeServer.Status(422, """{"detail":"Filename is required."}""") : FakeServer.Ok();
        await rig.Cycle();
        await rig.Cycle();
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR1.xml", "PJR2.xml"], rig.Server.Uploads);
        Assert.Equal(1, rig.Engine.Status.SkippedTotal);
        Assert.Contains("PJR1.xml\t", File.ReadAllText(rig.Paths.SkippedLedger));
        Assert.Contains("Filename is required.", File.ReadAllText(rig.Paths.SkippedLedger));
    }

    [Fact]
    public async Task A_422_from_the_request_check_skips_nothing_and_asks_for_an_update()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
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
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        var times = new List<DateTimeOffset>();
        rig.Server.Answer = _ =>
        {
            times.Add(rig.Clock.GetUtcNow());
            return times.Count == 1
                ? FakeServer.Status(429, """{"detail":"Too many requests — try again in a moment."}""")
                : FakeServer.Ok();
        };
        await rig.Cycle();
        while (times.Count < 2) await rig.Cycle();
        Assert.Equal(TimeSpan.FromMinutes(1), times[1] - times[0]);
        Assert.Equal(1, rig.Engine.Status.SentTotal);
    }

    [Fact]
    public async Task Server_errors_back_off_and_newer_files_never_overtake_the_failing_one()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
        var tries = new List<DateTimeOffset>();
        rig.Server.Answer = name =>
        {
            tries.Add(rig.Clock.GetUtcNow());
            return name == "PJR1.xml" ? FakeServer.Status(500, "boom") : FakeServer.Ok();
        };
        await rig.Cycle();
        while (tries.Count < 6) await rig.Cycle();
        // A long outage: only ever the oldest file, never the newer one.
        Assert.All(rig.Server.Uploads, n => Assert.Equal("PJR1.xml", n));
        var gaps = tries.Zip(tries.Skip(1), (a, b) => b - a).ToList();
        Assert.Equal(
            [TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15), TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5)],
            gaps);
        Assert.Equal(ProcessorState.RetryLater, rig.Engine.Status.State);
        Assert.Contains("Stuck on PJR1.xml", rig.Engine.Status.LastError);
        Assert.Contains(rig.Log.Lines, l => l.Level == LogLevel.Error && l.Message.Contains("Stuck on PJR1.xml"));
        Assert.Equal(0, rig.Engine.Status.SentTotal);

        // The server is fixed: the oldest goes first, then the next.
        rig.Server.Answer = _ => FakeServer.Ok();
        rig.Clock.Advance(TimeSpan.FromMinutes(5));
        await rig.Cycle();
        Assert.Equal(["PJR1.xml", "PJR2.xml"], rig.Server.Uploads.Distinct());
        Assert.Equal("PJR2.xml", rig.Server.Uploads[^1]);
        Assert.Equal(2, rig.Engine.Status.SentTotal);
        Assert.Contains("going through again", rig.Log.All);
    }

    [Fact]
    public async Task A_network_failure_is_never_a_drop()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Server.Answer = _ => UploadAnswers.FromException(new HttpRequestException("No such host is known."));
        await rig.Cycle();
        for (var i = 0; i < 20; i++) await rig.Cycle();
        Assert.Equal(0, rig.Engine.Status.SentTotal);
        Assert.Equal(0, rig.Engine.Status.SkippedTotal);
        Assert.Equal(1, rig.Engine.Status.Waiting);
        rig.Server.Answer = _ => FakeServer.Ok();
        rig.Clock.Advance(TimeSpan.FromMinutes(5));
        await rig.Cycle();
        Assert.Equal(1, rig.Engine.Status.SentTotal);
    }

    [Fact]
    public async Task Too_large_or_too_long_a_name_is_skipped_without_sending()
    {
        using var rig = new Rig();
        rig.Folder.Files["PJR1.xml"] = (new byte[ServerContract.MaxFileBytes + 1], W0);
        rig.Folder.Put("PJR" + new string('9', 120) + ".xml", "<a/>", W0.AddSeconds(1));
        rig.Folder.Files["PJR2.xml"] = (new byte[ServerContract.MaxFileBytes], W0.AddSeconds(2));
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR2.xml"], rig.Server.Uploads);
        Assert.Equal(2, rig.Engine.Status.SkippedTotal);
        var skipped = File.ReadAllText(rig.Paths.SkippedLedger);
        Assert.Contains("too_large", skipped);
        Assert.Contains("name_too_long", skipped);
    }

    [Fact]
    public async Task A_file_still_being_written_holds_back_everything_newer()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
        // PJR1 grew between the listing and the read.
        rig.Folder.ReadOverride = f => f.Name == "PJR1.xml" ? null : rig.Folder.Files[f.Name].Content;
        await rig.Cycle();
        await rig.Cycle();
        Assert.Empty(rig.Server.Uploads);
        rig.Folder.ReadOverride = null;
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR1.xml", "PJR2.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task A_file_removed_before_it_was_read_is_let_go()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
        rig.Folder.ReadOverride = f => f.Name == "PJR1.xml" ? throw new FileNotFoundException() : rig.Folder.Files[f.Name].Content;
        await rig.Cycle();
        await rig.Cycle();
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
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(["PJR1.xml"], rig.Server.Uploads);
    }

    [Fact]
    public async Task Without_a_key_it_waits_and_says_so()
    {
        using var rig = new Rig();
        rig.Config.Set(new EngineConfig(new ProcessorSettings(), new Uri("https://dinerobook.com"), null,
            ProcessorState.NotSignedIn, "Not signed in."));
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        var wait = await rig.Cycle();
        await rig.Cycle();
        Assert.Equal(ProcessorEngine.RecheckEvery, wait);
        Assert.Empty(rig.Server.Uploads);
        Assert.Equal(ProcessorState.NotSignedIn, rig.Engine.Status.State);
    }

    [Fact]
    public async Task A_backlog_is_paced_under_the_servers_limit()
    {
        using var rig = new Rig();
        for (var i = 0; i < 400; i++) rig.Folder.Put($"PJR{i:D5}.xml", "<a/>", W0.AddSeconds(i));
        var start = rig.Clock.GetUtcNow();
        var times = new List<DateTimeOffset>();
        rig.Server.Answer = _ =>
        {
            times.Add(rig.Clock.GetUtcNow());
            return FakeServer.Ok();
        };
        while (rig.Engine.Status.SentTotal < 400) await rig.Cycle();
        Assert.Equal(400, rig.Server.Uploads.Count);
        Assert.Equal(Enumerable.Range(0, 400).Select(i => $"PJR{i:D5}.xml"), rig.Server.Uploads);
        for (var i = 0; i < times.Count; i++)
        {
            Assert.True(times.Skip(i).TakeWhile(t => t < times[i].AddMinutes(1)).Count() <= UploadPacer.PerMinute);
        }
        Assert.InRange(rig.Clock.GetUtcNow() - start, TimeSpan.FromMinutes(4.5), TimeSpan.FromMinutes(6));
        Assert.Contains("waiting.", rig.Log.All);
    }

    [Fact]
    public async Task The_key_never_reaches_the_status_or_the_log()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<b/>", W0.AddSeconds(1));
        var n = 0;
        rig.Server.Answer = _ => ++n switch
        {
            1 => FakeServer.Status(401, "{}"),
            2 => FakeServer.Status(500, "x"),
            _ => FakeServer.Ok(),
        };
        for (var i = 0; i < 80; i++) await rig.Cycle();
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
        rig.Engine = new ProcessorEngine(rig.Paths, rig.Config, rig.Folder, rig.Server.For, rig.Clock, rig.Log, "0.1.0", rig.Clock.Delay);
        rig.Folder.Put("PJR1.xml", "<a/>", W0);
        rig.Folder.Put("PJR2.xml", "<a/>", W0);
        await rig.Cycle();
        await rig.Cycle();
        var status = ProcessorStatus.TryRead(rig.Paths.Status)!;
        Assert.True(status.Running);
        Assert.Equal(2, status.TodayCount);
        Assert.Equal(0, status.Waiting);
        Assert.Equal("Main St", status.StoreName);
        Assert.Equal("https://dinerobook.com", status.ApiUrl);
        Assert.Equal("PJR2.xml", status.LastUploadFile);
        Assert.Equal("0.1.0", status.Version);
    }
}
