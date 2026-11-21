using DineroBook.Processor;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Processor.Tests;

/// <summary>
/// The service's log files: one a day, and only today's is kept (owner,
/// 2026-11-21).
/// </summary>
public class RollingFileLoggerTests
{
    [Fact]
    public void Only_todays_log_is_kept()
    {
        using var dir = new TempDir();
        var today = new DateOnly(2026, 11, 21);
        foreach (var old in new[] { today.AddDays(-1), today.AddDays(-14) })
        {
            File.WriteAllText(Path.Combine(dir.Path, RollingFileLoggerProvider.FileNameFor("processor", old)), "old\r\n");
        }
        File.WriteAllText(Path.Combine(dir.Path, "notes.txt"), "not a log"); // not ours

        var now = new DateTimeOffset(today.ToDateTime(new TimeOnly(0, 5)), TimeZoneInfo.Local.GetUtcOffset(today.ToDateTime(new TimeOnly(0, 5))));
        using (var provider = new RollingFileLoggerProvider(dir.Path, now: () => now))
        {
            provider.CreateLogger("test").LogInformation("first line of the day");
        }

        var logs = Directory.GetFiles(dir.Path, "processor-*.log").Select(Path.GetFileName).ToList();
        Assert.Equal([RollingFileLoggerProvider.FileNameFor("processor", today)], logs);
        Assert.Contains("first line of the day", File.ReadAllText(Path.Combine(dir.Path, logs[0]!)));
        Assert.True(File.Exists(Path.Combine(dir.Path, "notes.txt")));
    }

    [Fact]
    public void A_new_day_deletes_yesterdays_log()
    {
        using var dir = new TempDir();
        var now = new DateTimeOffset(2026, 11, 20, 23, 59, 0, TimeZoneInfo.Local.GetUtcOffset(new DateTime(2026, 11, 20, 23, 59, 0)));
        using var provider = new RollingFileLoggerProvider(dir.Path, now: () => now);
        var log = provider.CreateLogger("test");
        log.LogInformation("late at night");
        Assert.Single(Directory.GetFiles(dir.Path, "processor-*.log"));

        now = now.AddMinutes(2); // past midnight
        log.LogInformation("a new day");

        var logs = Directory.GetFiles(dir.Path, "processor-*.log").Select(Path.GetFileName).ToList();
        Assert.Equal([RollingFileLoggerProvider.FileNameFor("processor", new DateOnly(2026, 11, 21))], logs);
    }
}
