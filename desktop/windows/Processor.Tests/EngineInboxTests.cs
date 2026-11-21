using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

/// <summary>
/// The engine as the service runs it: sending from the local inbox the
/// collector fills, tidying each inbox copy away once the server has it, and
/// still showing the Passport folder (and its problems) on the status page.
/// </summary>
public class EngineInboxTests
{
    private const string D = "2026-11-17";
    private const string Inbox = @"C:\ProgramData\DineroBook\Processor\state\inbox";
    private static readonly DateTime W0 = new(2026, 11, 17, 8, 0, 0, DateTimeKind.Utc);

    private sealed class Rig : IDisposable
    {
        public readonly TempDir Dir = new();
        public readonly ManualClock Clock = new(new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero));
        public readonly FakeFolder Folder = new();
        public readonly FakeServer Server = new();
        public readonly ListLogger Log = new();
        public readonly FixedConfig Config = new(FixedConfig.Running());
        public readonly List<string> Finished = new();
        public readonly List<string> Listed = new();
        public bool KeptCopies;
        public ProcessorEngine.SourceInfo Source;
        public readonly ProcessorEngine Engine;

        public Rig()
        {
            var paths = new DataPaths(Dir.Path, isCustom: true);
            Engine = new ProcessorEngine(paths, Config, new ListingSpy(Folder, Listed), Server.For, Clock, Log, "0.1.0",
                _ => { }, inbox: Inbox, onFinished: (name, settings) =>
                {
                    Finished.Add(name);
                    KeptCopies = !settings.DeleteFromInbox;
                    Folder.Files.Remove(name);
                }, source: () => Source);
        }

        public async Task Until(Func<bool> done)
        {
            var end = Clock.GetUtcNow().AddHours(1);
            while (!done() && Clock.GetUtcNow() < end)
            {
                Clock.Advance(await Engine.RunCycleAsync(CancellationToken.None));
            }
            Assert.True(done(), "condition not reached");
        }

        public void Dispose() => Dir.Dispose();
    }

    /// <summary>Records which folder the engine lists.</summary>
    private sealed class ListingSpy(FakeFolder inner, List<string> listed) : IPassportFolder
    {
        public IReadOnlyList<FileSnapshot> List(string folder)
        {
            listed.Add(folder);
            return inner.List(folder);
        }

        public BusinessDay ReadDay(FileSnapshot file, bool complete) => inner.ReadDay(file, complete);

        public Task<byte[]?> ReadAsync(FileSnapshot file, CancellationToken ct) => inner.ReadAsync(file, ct);
    }

    [Fact]
    public async Task It_sends_from_the_inbox_and_tidies_each_copy_away()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR001.xml", Naxml.Sale(D), W0);

        await rig.Until(() => rig.Finished.Count == 1);

        Assert.Equal(["PJR001.xml"], rig.Server.Uploads);
        Assert.Equal(["PJR001.xml"], rig.Finished);
        Assert.False(rig.KeptCopies, "the settings say delete by default");
        Assert.All(rig.Listed, f => Assert.Equal(Inbox, f));
        // The status page still names Passport's folder, not the inbox.
        Assert.Equal(@"\\10.5.48.2\XMLGateway\BOOutBox", rig.Engine.Status.WatchFolder);
    }

    [Fact]
    public async Task Every_file_goes_at_once_as_it_came_whatever_its_business_day()
    {
        using var rig = new Rig();
        // A later business day written first, then an earlier one: no
        // order by day, no wait for a file to settle (owner, 2026-11-20).
        rig.Folder.Put("PJR-later-day.xml", Naxml.Sale("2026-11-18"), W0);
        rig.Folder.Put("PJR-earlier-day.xml", Naxml.Sale(D), W0.AddSeconds(1));

        await rig.Engine.RunCycleAsync(CancellationToken.None); // one pass

        Assert.Equal(["PJR-later-day.xml", "PJR-earlier-day.xml"], rig.Server.Uploads);
        Assert.Equal("", rig.Engine.Status.WaitingOn);
    }

    [Fact]
    public async Task A_file_refused_for_good_leaves_the_inbox_too()
    {
        using var rig = new Rig();
        rig.Server.Answer = _ => FakeServer.Status(422, "{\"detail\":\"File too large.\"}");
        rig.Folder.Put("PJR002.xml", Naxml.Sale(D), W0);

        await rig.Until(() => rig.Finished.Count == 1);

        Assert.Equal(1, rig.Engine.Status.SkippedTotal);
    }

    [Fact]
    public async Task An_inbox_copy_of_a_file_already_sent_is_tidied_away_unsent()
    {
        using var rig = new Rig();
        rig.Folder.Put("PJR003.xml", Naxml.Sale(D), W0);
        await rig.Until(() => rig.Finished.Count == 1);

        // The service stopped between the answer and the delete.
        rig.Folder.Put("PJR003.xml", Naxml.Sale(D), W0);
        rig.Clock.Advance(TimeSpan.FromMinutes(1));
        await rig.Until(() => rig.Finished.Count == 2);

        Assert.Single(rig.Server.Uploads);
    }

    [Fact]
    public async Task A_Passport_folder_problem_shows_while_copied_files_still_go()
    {
        using var rig = new Rig();
        rig.Source = new ProcessorEngine.SourceInfo("Cannot open the Passport folder X: gone", Missed: 2);
        rig.Folder.Put("PJR004.xml", Naxml.Sale(D), W0);

        await rig.Until(() => rig.Finished.Count == 1);
        await rig.Engine.RunCycleAsync(CancellationToken.None);

        Assert.Equal(ProcessorState.FolderUnavailable, rig.Engine.Status.State);
        Assert.StartsWith("Cannot open the Passport folder X", rig.Engine.Status.Message);
        Assert.Equal(2, rig.Engine.Status.MissedTotal);
        Assert.Equal(["PJR004.xml"], rig.Server.Uploads);
    }
}
