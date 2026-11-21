using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

/// <summary>A watcher the test feeds by hand.</summary>
internal sealed class FakeWatcher : IOutboxWatcher
{
    public readonly List<string> Names = new();
    public bool Alive { get; set; } = true;
    public Task Noticed => Task.CompletedTask;

    public IReadOnlyList<string> TakeNames()
    {
        var list = Names.ToList();
        Names.Clear();
        return list;
    }

    public void Dispose() => Alive = false;
}

/// <summary>
/// <see cref="OutboxCollector"/>: each Passport file is copied to this
/// computer's inbox the moment nobody is writing it, never twice, and its
/// original is deleted only when "Delete files from XMLGateway" is ticked.
/// Real folders on disk (the share is a temp folder here).
/// </summary>
public class CollectorTests
{
    private const string D = "2026-11-17";

    private sealed class Rig : IDisposable
    {
        public readonly TempDir Share = new();
        public readonly TempDir Data = new();
        public readonly ManualClock Clock = new(new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero));
        public readonly ListLogger Log = new();
        public readonly FixedConfig Config;
        public readonly DataPaths Paths;
        public FakeWatcher? Watcher;
        public int Copied;
        public OutboxCollector Collector;

        public Rig(bool delete = false, bool watch = false, string? folder = null)
        {
            Paths = new DataPaths(Data.Path, isCustom: true);
            Config = new FixedConfig(Settings(folder ?? Share.Path, delete));
            if (watch) Watcher = new FakeWatcher();
            Collector = New();
        }

        public static EngineConfig Settings(string folder, bool delete) =>
            new(new ProcessorSettings { WatchFolder = folder, DeleteFromOutbox = delete, StoreName = "Main St" },
                new Uri("https://dinerobook.com"), EngineTests.Key, "", "");

        public OutboxCollector New() => new(Paths, Config, new PassportFolder(), Clock, Log,
            watcherFor: Watcher is null ? null : _ => Watcher,
            onCopied: () => Copied++);

        public string Put(string name, string? xml = null)
        {
            var path = Share.File(name);
            File.WriteAllBytes(path, Naxml.Bytes(xml ?? Naxml.Sale(D)));
            return path;
        }

        public string InInbox(string name) => Path.Combine(Paths.Inbox, name);

        public TimeSpan Pass() => Collector.RunOnce();

        public void Dispose()
        {
            Collector.Dispose();
            foreach (var f in Directory.EnumerateFiles(Share.Path))
            {
                File.SetAttributes(f, FileAttributes.Normal);
            }
            Share.Dispose();
            Data.Dispose();
        }
    }

    [Fact]
    public void A_new_file_is_copied_to_the_inbox_and_the_original_is_left_alone()
    {
        using var rig = new Rig();
        var original = rig.Put("PJR001.xml");

        rig.Pass();

        Assert.True(File.Exists(rig.InInbox("PJR001.xml")));
        Assert.Equal(File.ReadAllBytes(original), File.ReadAllBytes(rig.InInbox("PJR001.xml")));
        Assert.True(File.Exists(original), "unticked: Passport's file stays for Modisoft");
        Assert.Equal(1, rig.Copied);
        Assert.Equal(1, rig.Collector.CopiedCount);
        Assert.Equal(0, rig.Collector.Pending);
        // Moved in whole: nothing half-written is left beside the inbox.
        Assert.Empty(Directory.EnumerateFiles(rig.Paths.Incoming));
        Assert.Contains("PJR001.xml", File.ReadAllText(rig.Paths.CollectedLedger));
    }

    [Fact]
    public void The_original_is_deleted_only_when_the_box_is_ticked()
    {
        using var rig = new Rig(delete: true);
        var original = rig.Put("PJR001.xml");

        rig.Pass();

        Assert.True(File.Exists(rig.InInbox("PJR001.xml")));
        Assert.False(File.Exists(original));
        Assert.Equal(1, rig.Collector.DeletedCount);
        Assert.Equal("", rig.Collector.Problem);
    }

    [Fact]
    public void A_file_Passport_is_still_writing_waits_until_it_is_closed()
    {
        // The watcher reports a file the moment it is created; a listing
        // may still show it as 0 bytes until Passport closes it.
        using var rig = new Rig(watch: true);
        rig.Pass();
        var path = rig.Share.File("PJR002.xml");
        using (var writer = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read))
        {
            var bytes = Naxml.Bytes(Naxml.Sale(D));
            writer.Write(bytes, 0, bytes.Length);
            writer.Flush();
            rig.Watcher!.Names.Add("PJR002.xml");
            rig.Clock.Advance(TimeSpan.FromSeconds(1));

            rig.Pass();

            Assert.False(File.Exists(rig.InInbox("PJR002.xml")), "copied while still being written");
            Assert.Equal(1, rig.Collector.Pending);
        }

        rig.Clock.Advance(OutboxCollector.RetryBusyEvery);
        rig.Pass();

        Assert.True(File.Exists(rig.InInbox("PJR002.xml")));
        Assert.Equal(0, rig.Collector.Pending);
    }

    [Fact]
    public void A_file_is_never_copied_twice_not_even_after_a_restart()
    {
        using var rig = new Rig();
        rig.Put("PJR003.xml");
        rig.Pass();
        // Sent and tidied away; the original is still in BOOutbox.
        File.Delete(rig.InInbox("PJR003.xml"));

        rig.Clock.Advance(TimeSpan.FromMinutes(1));
        rig.Pass();
        Assert.False(File.Exists(rig.InInbox("PJR003.xml")));

        rig.Collector.Dispose();
        rig.Collector = rig.New();
        rig.Pass();
        Assert.False(File.Exists(rig.InInbox("PJR003.xml")));
        Assert.Equal(1, rig.Copied);
    }

    [Fact]
    public void Empty_and_hidden_files_are_left()
    {
        using var rig = new Rig();
        File.WriteAllBytes(rig.Share.File("PJR-empty.xml"), Array.Empty<byte>());
        var hidden = rig.Put("PJR-temp.xml");
        File.SetAttributes(hidden, FileAttributes.Hidden);

        rig.Pass();

        Assert.Empty(Directory.EnumerateFiles(rig.Paths.Inbox));
    }

    [Fact]
    public void A_delete_that_fails_is_reported_and_the_copy_still_goes()
    {
        using var rig = new Rig(delete: true);
        var original = rig.Put("PJR004.xml");
        File.SetAttributes(original, FileAttributes.ReadOnly);

        rig.Pass();

        Assert.True(File.Exists(rig.InInbox("PJR004.xml")));
        Assert.True(File.Exists(original));
        Assert.StartsWith("Could not delete PJR004.xml from the Passport folder", rig.Collector.Problem);
        Assert.Equal(0, rig.Collector.DeletedCount);
    }

    [Fact]
    public void A_folder_that_cannot_be_opened_is_reported()
    {
        using var rig = new Rig(folder: @"C:\definitely\not\here\BOOutBox");

        rig.Pass();

        Assert.StartsWith(@"Cannot open the Passport folder C:\definitely\not\here\BOOutBox", rig.Collector.Problem);
    }

    [Fact]
    public void The_watcher_brings_a_file_in_before_the_next_listing()
    {
        using var rig = new Rig(watch: true);
        rig.Pass(); // first listing: nothing yet
        rig.Put("PJR005.xml");
        rig.Watcher!.Names.Add("PJR005.xml");
        rig.Clock.Advance(TimeSpan.FromSeconds(1)); // the next listing is 5 s away

        rig.Pass();

        Assert.True(File.Exists(rig.InInbox("PJR005.xml")));
    }

    [Fact]
    public void A_file_taken_by_another_program_first_counts_as_missed()
    {
        using var rig = new Rig(watch: true);
        rig.Pass();
        rig.Watcher!.Names.Add("PJR006.xml"); // noticed, then gone before the copy

        rig.Pass();

        Assert.Equal(1, rig.Collector.MissedCount);
        Assert.Equal(0, rig.Collector.Pending);
        Assert.Contains("left the Passport folder before it could be copied", rig.Log.All);
    }

    [Fact]
    public void A_watcher_that_died_is_replaced_and_the_folder_listed_again()
    {
        using var rig = new Rig(watch: true);
        rig.Pass();
        rig.Watcher!.Alive = false;
        rig.Put("PJR007.xml");
        rig.Clock.Advance(TimeSpan.FromSeconds(1));

        rig.Pass();

        Assert.True(File.Exists(rig.InInbox("PJR007.xml")), "the listing after the watcher died picks it up");
        Assert.Contains("stopped; making a new one", rig.Log.All);
    }

    [Fact]
    public void Nothing_is_collected_until_the_store_is_connected()
    {
        using var rig = new Rig();
        rig.Config.Set(new EngineConfig(new ProcessorSettings { WatchFolder = rig.Share.Path }, null, null,
            ProcessorState.NotSignedIn, "Not connected."));
        rig.Put("PJR008.xml");

        rig.Pass();

        Assert.False(Directory.Exists(rig.Paths.Inbox) && File.Exists(rig.InInbox("PJR008.xml")));
    }
}
