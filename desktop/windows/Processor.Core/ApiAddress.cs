namespace DineroBook.Processor;

/// <summary>
/// Which DineroBook addresses the Processor and the Manager will talk to:
/// https only, or plain http to a test server on this computer
/// (localhost, 127.0.0.1, ::1). Only the scheme, host and port count; an
/// address with a path, query or user name is refused rather than trimmed,
/// so a typo never quietly sends a store's files somewhere else.
/// </summary>
public static class ApiAddress
{
    public static bool TryParse(string? text, out Uri baseUri, out string error)
    {
        baseUri = new Uri(ServerContract.DefaultApiUrl);
        error = "";
        var t = (text ?? "").Trim();
        if (t.Length == 0)
        {
            error = "Enter the DineroBook address, like https://dinerobook.com.";
            return false;
        }
        if (!Uri.TryCreate(t, UriKind.Absolute, out var u))
        {
            error = "That is not a web address. Use https://dinerobook.com.";
            return false;
        }
        // A file: address counts as "loopback" to Uri, so the scheme is
        // checked first.
        var https = u.Scheme == Uri.UriSchemeHttps;
        var localTest = u.Scheme == Uri.UriSchemeHttp && u.IsLoopback;
        if (!https && !localTest)
        {
            error = "The address must start with https:// (plain http only for a test server on this computer).";
            return false;
        }
        if (u.UserInfo.Length > 0 || u.AbsolutePath != "/" || u.Query.Length > 0 || u.Fragment.Length > 0)
        {
            error = "Use just the address, like https://dinerobook.com (no path after it).";
            return false;
        }
        baseUri = new Uri(u.GetLeftPart(UriPartial.Authority));
        return true;
    }

    /// <summary>A server path (<see cref="ServerContract"/>) on this address.</summary>
    public static Uri Combine(Uri baseUri, string path) => new(baseUri, path);
}
