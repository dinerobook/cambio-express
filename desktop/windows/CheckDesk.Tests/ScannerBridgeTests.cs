using System.Text.Json.Nodes;
using DineroBook.CheckDesk;
using Xunit;

namespace CheckDesk.Tests;

// The page's scanner messages (CheckCashing INVARIANTS "Scanner").
public class ScannerBridgeTests
{
    private sealed class FakeScanner : IScanner
    {
        public bool Ready { get; set; } = true;
        public Func<CancellationToken, Task<ScanResult>> Scan { get; set; } =
            _ => Task.FromResult(new ScanResult(
                "T111000025T 4400123456U 0232", "111000025", "4400123456", "232", 175000,
                new byte[] { 1, 2 }, null));

        public Task<bool> IsReadyAsync() => Ready ? Task.FromResult(true) : throw new DllNotFoundException();

        public Task<ScanResult> ScanAsync(CancellationToken cancel) => Scan(cancel);
    }

    private static JsonObject Parse(string? json) => (JsonObject)JsonNode.Parse(json!)!;

    [Fact]
    public async Task Status_says_ready()
    {
        var reply = Parse(await new ScannerBridge(new FakeScanner()).HandleAsync("""{"type":"scanner.status","id":4}"""));
        Assert.Equal("scanner.reply", (string)reply["type"]!);
        Assert.Equal(4, (long)reply["id"]!);
        Assert.True((bool)reply["ok"]!);
        Assert.Equal("ready", (string)reply["status"]!);
    }

    [Fact]
    public async Task Status_says_not_connected_when_the_library_is_missing()
    {
        var bridge = new ScannerBridge(new FakeScanner { Ready = false });
        var reply = Parse(await bridge.HandleAsync("""{"type":"scanner.status","id":1}"""));
        Assert.Equal("not_connected", (string)reply["status"]!);
    }

    [Fact]
    public async Task Scan_sends_the_numbers_and_the_pictures()
    {
        var reply = Parse(await new ScannerBridge(new FakeScanner()).HandleAsync("""{"type":"scanner.scan","id":9}"""));
        Assert.True((bool)reply["ok"]!);
        var micr = (JsonObject)reply["micr"]!;
        Assert.Equal("111000025", (string)micr["routing"]!);
        Assert.Equal("4400123456", (string)micr["account"]!);
        Assert.Equal("232", (string)micr["number"]!);
        Assert.Equal(175000, (long)micr["amount_cents"]!);
        Assert.Equal("T111000025T 4400123456U 0232", (string)micr["raw"]!);
        Assert.Equal("AQI=", (string)reply["front"]!);
        Assert.Null(reply["back"]);
    }

    [Fact]
    public async Task A_scanner_error_keeps_its_code()
    {
        var bridge = new ScannerBridge(new FakeScanner
        {
            Scan = _ => throw new ScannerException(ScanErrors.Jam),
        });
        var reply = Parse(await bridge.HandleAsync("""{"type":"scanner.scan","id":2}"""));
        Assert.False((bool)reply["ok"]!);
        Assert.Equal("jam", (string)reply["error"]!);
    }

    [Fact]
    public async Task Any_other_failure_is_failed()
    {
        var bridge = new ScannerBridge(new FakeScanner { Scan = _ => throw new InvalidOperationException() });
        var reply = Parse(await bridge.HandleAsync("""{"type":"scanner.scan","id":2}"""));
        Assert.Equal("failed", (string)reply["error"]!);
    }

    [Fact]
    public async Task One_scan_at_a_time_and_cancel_ends_the_waiting_one()
    {
        var never = new TaskCompletionSource<ScanResult>();
        var fake = new FakeScanner();
        var success = fake.Scan;
        fake.Scan = _ => never.Task;
        var bridge = new ScannerBridge(fake);
        var first = bridge.HandleAsync("""{"type":"scanner.scan","id":1}""");
        var second = Parse(await bridge.HandleAsync("""{"type":"scanner.scan","id":2}"""));
        Assert.Equal("busy", (string)second["error"]!);

        Assert.Null(await bridge.HandleAsync("""{"type":"scanner.cancel"}"""));
        var ended = Parse(await first);
        Assert.Equal(1, (long)ended["id"]!);
        Assert.Equal("no_check", (string)ended["error"]!);

        // The scanner is free again.
        fake.Scan = success;
        var third = Parse(await bridge.HandleAsync("""{"type":"scanner.scan","id":3}"""));
        Assert.True((bool)third["ok"]!);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[1,2]")]
    [InlineData("""{"type":"other","id":1}""")]
    [InlineData("""{"type":"scanner.scan"}""")]
    [InlineData("""{"type":5,"id":1}""")]
    public async Task Anything_else_gets_no_answer(string message)
    {
        Assert.Null(await new ScannerBridge(new FakeScanner()).HandleAsync(message));
    }
}
