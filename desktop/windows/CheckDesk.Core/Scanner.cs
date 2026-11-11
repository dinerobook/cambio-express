namespace DineroBook.CheckDesk;

/// <summary>What the scanner read from one check. The routing, account
/// and check number come from the scanner's own MICR parse; the page
/// parses <see cref="Raw"/> itself when they are empty.</summary>
public sealed record ScanResult(
    string Raw,
    string Routing,
    string Account,
    string Number,
    long? AmountCents,
    byte[]? Front,
    byte[]? Back);

/// <summary>The reasons a scan gives nothing, as the page knows them
/// (frontend/src/lib/scanner.ts ScanErrorCode).</summary>
public static class ScanErrors
{
    public const string NotConnected = "not_connected";
    public const string NoCheck = "no_check";
    public const string Jam = "jam";
    public const string Busy = "busy";
    public const string Failed = "failed";
}

public sealed class ScannerException : Exception
{
    public string Code { get; }

    public ScannerException(string code, string message = "") : base(message == "" ? code : message)
    {
        Code = code;
    }
}

/// <summary>A check scanner. <see cref="ScanAsync"/> gets it ready and
/// returns when a check has gone through, or throws a
/// <see cref="ScannerException"/>.</summary>
public interface IScanner
{
    /// <summary>True when the scanner is plugged in and answers.</summary>
    Task<bool> IsReadyAsync();

    Task<ScanResult> ScanAsync(CancellationToken cancel);
}
