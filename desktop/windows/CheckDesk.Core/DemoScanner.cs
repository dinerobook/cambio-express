namespace DineroBook.CheckDesk;

/// <summary>A pretend scanner for trying the window without an Excella:
/// after a moment it "reads" a sample check with no pictures.</summary>
public sealed class DemoScanner : IScanner
{
    private readonly TimeSpan _delay;

    public DemoScanner(TimeSpan? delay = null)
    {
        _delay = delay ?? TimeSpan.FromSeconds(2);
    }

    public Task<bool> IsReadyAsync() => Task.FromResult(true);

    public async Task<ScanResult> ScanAsync(CancellationToken cancel)
    {
        await Task.Delay(_delay, cancel);
        return new ScanResult(
            "T111000025T 4400123456U 0232", "111000025", "4400123456", "232", null, null, null);
    }
}
