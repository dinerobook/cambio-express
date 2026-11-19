using System.Runtime.ExceptionServices;

namespace DineroBook.Processor;

/// <summary>One file in a folder listing: name, size and last write time,
/// as the listing itself reports them (no file is opened to get them).</summary>
public readonly record struct FileSnapshot(string Name, string FullPath, long Length, DateTime LastWriteUtc);

/// <summary>Passport's outbox, read only.</summary>
public interface IPassportFolder
{
    /// <summary>The files directly in the folder (no subfolders), with the
    /// size and time the listing reports. Throws when the folder cannot be
    /// listed (<see cref="FolderTimeoutException"/> when it does not answer).</summary>
    IReadOnlyList<FileSnapshot> List(string folder);

    /// <summary>The file's business day (<see cref="BusinessDateReader"/>).
    /// <paramref name="complete"/>: the file held still. Throws
    /// FileNotFoundException when it is gone, IOException when it cannot be
    /// opened just now, <see cref="FolderTimeoutException"/> when the share
    /// does not answer.</summary>
    BusinessDay ReadDay(FileSnapshot file, bool complete);

    /// <summary>The whole file, or null when its size is no longer the
    /// listed one (Passport is still writing it).</summary>
    Task<byte[]?> ReadAsync(FileSnapshot file, CancellationToken ct);
}

/// <summary>Which names may go. Every file Passport writes goes as it is
/// (owner, 2026-11-18: no file name or extension filter); only a name the
/// sent ledger's one-name-per-line format cannot hold is left. Windows never
/// allows control characters in a name, so in practice nothing is.</summary>
public static class FileNames
{
    public static bool Sendable(string fileName) => fileName.Length > 0 && !fileName.Any(char.IsControl);
}

/// <summary>A call to the Passport folder did not answer in time: the
/// network share, or the network to it, is down or very slow. An
/// IOException, so every caller that handles a folder it cannot read
/// handles this too.</summary>
public sealed class FolderTimeoutException(string message) : IOException(message);

/// <summary>
/// The real folder. Strictly read only: files are never moved, renamed,
/// deleted or locked — other back-office programs read the same folder.
/// Each file is opened for reading with ReadWrite | Delete sharing, so
/// Passport can keep writing, replacing or deleting it while we read.
/// <para>
/// The folder is a network share, and a call to a share that went away
/// does not fail: Windows can keep it waiting for many minutes (the owner's
/// LdPosService logs showed 12–16). So every call runs with a time limit
/// (<see cref="ListTimeout"/>, <see cref="DayTimeout"/>,
/// <see cref="FileTimeout"/>) and counts as "cannot read the folder" when it
/// runs out. A call still out when the next listing is due is waited on
/// again instead of starting another one, so a dead share never piles up
/// stuck threads.
/// </para>
/// </summary>
public sealed class PassportFolder : IPassportFolder
{
    public static readonly TimeSpan ListTimeout = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan DayTimeout = TimeSpan.FromSeconds(20);
    public static readonly TimeSpan FileTimeout = TimeSpan.FromSeconds(60);

    private static readonly EnumerationOptions ListOptions = new()
    {
        RecurseSubdirectories = false,
        IgnoreInaccessible = true,
        ReturnSpecialDirectories = false,
        // Hidden / system files are usually half-written temp files.
        AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
    };

    private readonly TimeSpan _listTimeout;
    private readonly TimeSpan _dayTimeout;
    private readonly TimeSpan _fileTimeout;
    private readonly object _gate = new();
    private Task<IReadOnlyList<FileSnapshot>>? _listing;
    private string _listingFolder = "";

    public PassportFolder(TimeSpan? listTimeout = null, TimeSpan? dayTimeout = null, TimeSpan? fileTimeout = null)
    {
        _listTimeout = listTimeout ?? ListTimeout;
        _dayTimeout = dayTimeout ?? DayTimeout;
        _fileTimeout = fileTimeout ?? FileTimeout;
    }

    /// <summary>Lists without a time limit, on the calling thread.</summary>
    internal static IReadOnlyList<FileSnapshot> ListNow(string folder)
    {
        var dir = new DirectoryInfo(folder);
        var list = new List<FileSnapshot>();
        foreach (var fi in dir.EnumerateFiles("*", ListOptions))
        {
            list.Add(new FileSnapshot(fi.Name, fi.FullName, fi.Length, fi.LastWriteTimeUtc));
        }
        return list;
    }

    public IReadOnlyList<FileSnapshot> List(string folder)
    {
        Task<IReadOnlyList<FileSnapshot>> listing;
        lock (_gate)
        {
            if (_listing is null || _listing.IsCompleted
                || !string.Equals(_listingFolder, folder, StringComparison.OrdinalIgnoreCase))
            {
                _listing = Task.Run(() => ListNow(folder));
                _listingFolder = folder;
            }
            listing = _listing;
        }
        return Wait(listing, _listTimeout, $"The folder {folder}");
    }

    public BusinessDay ReadDay(FileSnapshot file, bool complete) =>
        Wait(Task.Run(() =>
        {
            using var fs = OpenForRead(file.FullPath, async: false);
            return BusinessDateReader.Read(fs, complete);
        }), _dayTimeout, file.Name);

    public async Task<byte[]?> ReadAsync(FileSnapshot file, CancellationToken ct)
    {
        var read = Task.Run(async () =>
        {
            await using var fs = OpenForRead(file.FullPath, async: true);
            if (fs.Length != file.Length || fs.Length > ServerContract.MaxFileBytes) return null;
            var buffer = new byte[fs.Length];
            await fs.ReadExactlyAsync(buffer, ct).ConfigureAwait(false);
            return buffer;
        }, ct);
        try
        {
            return await read.WaitAsync(_fileTimeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            Observe(read);
            throw TimedOut(file.Name, _fileTimeout);
        }
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

    /// <summary>The call's answer, or <see cref="FolderTimeoutException"/>
    /// once <paramref name="timeout"/> runs out (the call itself is left to
    /// finish on its own). The call's own exception comes through as it is.</summary>
    internal static T Wait<T>(Task<T> call, TimeSpan timeout, string what)
    {
        try
        {
            if (!call.Wait(timeout))
            {
                Observe(call);
                throw TimedOut(what, timeout);
            }
        }
        catch (AggregateException ex) when (ex.InnerExceptions.Count == 1)
        {
            ExceptionDispatchInfo.Capture(ex.InnerException!).Throw();
        }
        return call.Result;
    }

    private static FolderTimeoutException TimedOut(string what, TimeSpan timeout) =>
        new($"{what} did not answer within {timeout.TotalSeconds:N0} seconds (is the network share down?)");

    /// <summary>A call given up on may still fail later; its error is
    /// looked at so it is not reported as unobserved.</summary>
    private static void Observe(Task call) =>
        _ = call.ContinueWith(t => _ = t.Exception, CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
}
