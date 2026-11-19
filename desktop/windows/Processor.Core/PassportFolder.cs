namespace DineroBook.Processor;

/// <summary>One file in a folder listing: name, size and last write time,
/// as the listing itself reports them (no file is opened to get them).</summary>
public readonly record struct FileSnapshot(string Name, string FullPath, long Length, DateTime LastWriteUtc);

/// <summary>Passport's outbox, read only.</summary>
public interface IPassportFolder
{
    /// <summary>The files directly in the folder (no subfolders), with the
    /// size and time the listing reports. Throws when the folder cannot be
    /// listed.</summary>
    IReadOnlyList<FileSnapshot> List(string folder);

    /// <summary>The file's business day (<see cref="BusinessDateReader"/>).
    /// <paramref name="complete"/>: the file held still. Throws
    /// FileNotFoundException when it is gone, IOException when it cannot be
    /// opened just now.</summary>
    BusinessDay ReadDay(FileSnapshot file, bool complete);

    /// <summary>The whole file, or null when its size is no longer the
    /// listed one (Passport is still writing it).</summary>
    Task<byte[]?> ReadAsync(FileSnapshot file, CancellationToken ct);
}

/// <summary>
/// The real folder. Strictly read only: files are never moved, renamed,
/// deleted or locked — other back-office programs read the same folder.
/// Each file is opened for reading with ReadWrite | Delete sharing, so
/// Passport can keep writing, replacing or deleting it while we read.
/// </summary>
public sealed class PassportFolder : IPassportFolder
{
    private static readonly EnumerationOptions ListOptions = new()
    {
        RecurseSubdirectories = false,
        IgnoreInaccessible = true,
        ReturnSpecialDirectories = false,
        // Hidden / system files are usually half-written temp files.
        AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
    };

    public IReadOnlyList<FileSnapshot> List(string folder)
    {
        var dir = new DirectoryInfo(folder);
        var list = new List<FileSnapshot>();
        foreach (var fi in dir.EnumerateFiles("*", ListOptions))
        {
            list.Add(new FileSnapshot(fi.Name, fi.FullName, fi.Length, fi.LastWriteTimeUtc));
        }
        return list;
    }

    public BusinessDay ReadDay(FileSnapshot file, bool complete)
    {
        using var fs = OpenForRead(file.FullPath, async: false);
        return BusinessDateReader.Read(fs, complete);
    }

    public async Task<byte[]?> ReadAsync(FileSnapshot file, CancellationToken ct)
    {
        await using var fs = OpenForRead(file.FullPath, async: true);
        if (fs.Length != file.Length || fs.Length > ServerContract.MaxFileBytes) return null;
        var buffer = new byte[fs.Length];
        await fs.ReadExactlyAsync(buffer, ct).ConfigureAwait(false);
        return buffer;
    }

    /// <summary>The one way a Passport file is opened: read access only,
    /// and every other program may go on reading, writing, renaming or
    /// deleting it while it is open.</summary>
    internal static FileStream OpenForRead(string path, bool async = false) => new(path, new FileStreamOptions
    {
        Mode = FileMode.Open,
        Access = FileAccess.Read,
        Share = FileShare.ReadWrite | FileShare.Delete,
        Options = FileOptions.SequentialScan | (async ? FileOptions.Asynchronous : FileOptions.None),
    });
}
