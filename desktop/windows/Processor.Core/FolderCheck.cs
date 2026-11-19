using System.Globalization;

namespace DineroBook.Processor;

/// <summary>The Manager's "Check" button: does the folder exist, can it be
/// listed, and can a Passport file in it be opened for reading? Reads only.</summary>
public static class FolderCheck
{
    public sealed record Result(bool Ok, string Message, int Matching);

    public static Result Check(string? folder, IReadOnlyList<string>? patterns = null)
    {
        var path = (folder ?? "").Trim();
        if (path.Length == 0) return new Result(false, "Choose the folder Passport writes its XML files to.", 0);
        if (!Path.IsPathFullyQualified(path)) return new Result(false, @"Use a full path, like C:\Passport\XMLGateway\BOOutbox or \\SERVER\BOOutbox.", 0);
        var match = new FilePatterns(patterns ?? ProcessorSettings.DefaultPatterns);
        try
        {
            if (!Directory.Exists(path)) return new Result(false, $"{path} does not exist (or this Windows login cannot see it).", 0);
            var listed = new PassportFolder().List(path).Where(f => match.Matches(f.Name)).ToList();
            if (listed.Count == 0)
            {
                return new Result(true, "The folder can be read, but no Passport files (PJR, FGM, ISM, MCM, MSM, TLM, TPM .xml) are in it yet.", 0);
            }
            var newest = listed.MaxBy(f => f.LastWriteUtc)!;
            using (var fs = PassportFolder.OpenForRead(newest.FullPath))
            {
                _ = fs.ReadByte();
            }
            return new Result(true, string.Format(CultureInfo.CurrentCulture,
                "Readable: {0:N0} Passport file(s); the newest is {1} ({2:g}).",
                listed.Count, newest.Name, newest.LastWriteUtc.ToLocalTime()), listed.Count);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return new Result(false, $"Cannot read {path}: {ex.Message}", 0);
        }
    }
}
