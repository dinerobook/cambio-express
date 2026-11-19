using System.Text.RegularExpressions;

namespace DineroBook.Processor;

/// <summary>
/// File name patterns like <c>PJR*.xml</c>: <c>*</c> is any run of
/// characters, <c>?</c> one character, case ignored (Windows names, and what
/// the Python agent's fnmatch does on Windows). Matched in code over one
/// folder listing, not by Windows' own wildcard search, which also matches
/// 8.3 short names (<c>*.xml</c> would catch <c>a.xmlold</c>).
/// </summary>
public sealed class FilePatterns
{
    private readonly Regex[] _patterns;

    public FilePatterns(IEnumerable<string> patterns)
    {
        _patterns = patterns
            .Select(p => new Regex(
                "^" + Regex.Escape(p).Replace(@"\*", ".*").Replace(@"\?", ".") + "$",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            .ToArray();
    }

    public bool Matches(string fileName)
    {
        // Windows never allows control characters in a name; refusing them
        // here keeps the ledger's one-name-per-line format safe.
        if (fileName.Length == 0 || fileName.Any(char.IsControl)) return false;
        foreach (var p in _patterns)
        {
            if (p.IsMatch(fileName)) return true;
        }
        return false;
    }
}
