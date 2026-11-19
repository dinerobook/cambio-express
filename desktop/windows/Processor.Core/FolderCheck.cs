using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace DineroBook.Processor;

/// <summary>The Manager's "Check" button: does the folder exist, can it be
/// listed, and can a file in it be opened for reading? Reads only, and gives
/// up after <see cref="Timeout"/> instead of hanging on a share that went
/// away.</summary>
public static class FolderCheck
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public sealed record Result(bool Ok, string Message, int Files);

    public static Result Check(string? folder, TimeSpan? timeout = null)
    {
        var path = (folder ?? "").Trim();
        if (path.Length == 0) return new Result(false, "Choose the folder Passport writes its files to (BOOutbox).", 0);
        if (!Path.IsPathFullyQualified(path))
        {
            return new Result(false, $@"Use the full network path, like {ProcessorSettings.DefaultWatchFolder}.", 0);
        }
        try
        {
            return PassportFolder.Wait(Task.Run(() => CheckNow(path)), timeout ?? Timeout, path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return new Result(false, $"Cannot read {path}: {ex.Message}", 0);
        }
    }

    private static Result CheckNow(string path)
    {
        if (!Directory.Exists(path)) return new Result(false, $"{path} does not exist (or this Windows login cannot see it).", 0);
        var listed = PassportFolder.ListNow(path).Where(f => FileNames.Sendable(f.Name)).ToList();
        if (listed.Count == 0) return new Result(true, "The folder can be read, but it has no files yet.", 0);
        var newest = listed.MaxBy(f => f.LastWriteUtc)!;
        using (var fs = PassportFolder.OpenForRead(newest.FullPath))
        {
            _ = fs.ReadByte();
        }
        return new Result(true, string.Format(CultureInfo.CurrentCulture,
            "Readable: {0:N0} file(s); the newest is {1} ({2:g}).",
            listed.Count, newest.Name, newest.LastWriteUtc.ToLocalTime()), listed.Count);
    }
}

/// <summary>What a drive letter is on this computer.</summary>
public interface IDriveMap
{
    /// <summary>True when the drive ("Z:") is a mapped network drive.</summary>
    bool IsNetworkDrive(string drive);

    /// <summary>The share a mapped drive points at ("\\server\share"), or
    /// null when Windows cannot say.</summary>
    string? ShareOf(string drive);
}

/// <summary>
/// The folder as the service must see it. A mapped drive letter (Z:) only
/// exists in the signed-in person's own Windows session; the service runs
/// in its own session under NetworkService and never sees it. So a mapped
/// drive is saved as the share it points at: <c>Z:\BOOutBox</c> becomes
/// <c>\\10.5.48.2\XMLGateway\BOOutBox</c> (the owner's LdPosService does the
/// same, its review point 18).
/// </summary>
public static class ServiceFolder
{
    public sealed record Result(string Path, string Note, string Problem)
    {
        public bool Ok => Problem.Length == 0;
    }

    public static bool IsShare(string path) => path.StartsWith(@"\\", StringComparison.Ordinal);

    public static Result Resolve(string? input, IDriveMap drives)
    {
        var path = (input ?? "").Trim();
        if (path.Length < 2 || IsShare(path) || path[1] != ':' || !char.IsAsciiLetter(path[0]))
        {
            return new Result(path, "", "");
        }
        var drive = char.ToUpperInvariant(path[0]) + ":";
        if (!drives.IsNetworkDrive(drive))
        {
            return new Result(path, $@"This folder is on this computer. Passport's BOOutbox is normally the network share {ProcessorSettings.DefaultWatchFolder}.", "");
        }
        var share = drives.ShareOf(drive);
        if (share is null || !IsShare(share))
        {
            return new Result(path, "",
                $@"{drive} is a network drive, and the service cannot use a drive letter. Choose the network path instead, like {ProcessorSettings.DefaultWatchFolder}.");
        }
        var rest = path[2..].TrimStart('\\');
        var unc = rest.Length > 0 ? share.TrimEnd('\\') + @"\" + rest : share.TrimEnd('\\');
        return new Result(unc, $"{drive} is a network drive; the service uses its network path {unc}.", "");
    }
}

/// <summary>Windows' own answer: <see cref="DriveInfo"/> for the drive type,
/// WNetGetConnection (mpr.dll) for the share behind a mapped letter.</summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsDriveMap : IDriveMap
{
    public bool IsNetworkDrive(string drive)
    {
        try
        {
            return new DriveInfo(drive).DriveType == DriveType.Network;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    public string? ShareOf(string drive)
    {
        var length = 512;
        var buffer = new StringBuilder(length);
        var error = WNetGetConnection(drive, buffer, ref length);
        if (error == ErrorMoreData)
        {
            buffer = new StringBuilder(length);
            error = WNetGetConnection(drive, buffer, ref length);
        }
        // A remembered connection that is not connected right now still
        // names its share.
        return error is 0 or ErrorConnectionUnavailable && buffer.Length > 0 ? buffer.ToString() : null;
    }

    private const int ErrorMoreData = 234;
    private const int ErrorConnectionUnavailable = 1201;

    [DllImport("mpr.dll", EntryPoint = "WNetGetConnectionW", CharSet = CharSet.Unicode)]
    private static extern int WNetGetConnection(string localName, StringBuilder remoteName, ref int length);
}
