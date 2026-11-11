namespace DineroBook.CheckDesk;

/// <summary>The window shows DineroBook and nothing else: an address on
/// another site opens in the computer's normal browser, and only
/// DineroBook pages may talk to the scanner.</summary>
public static class NavigationPolicy
{
    /// <summary>True when <paramref name="address"/> is on the same site
    /// (scheme, host and port) as <paramref name="home"/>.</summary>
    public static bool IsOwnPage(string? address, Uri home)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri)) return false;
        return string.Equals(uri.Scheme, home.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(uri.Host, home.Host, StringComparison.OrdinalIgnoreCase)
            && uri.Port == home.Port;
    }

    /// <summary>True for an address worth handing to the normal browser
    /// (a web or mail link), never a file or a program.</summary>
    public static bool MayOpenOutside(string? address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp
            || uri.Scheme == Uri.UriSchemeMailto);
}
