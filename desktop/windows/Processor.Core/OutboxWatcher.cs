using System.Collections.Concurrent;

namespace DineroBook.Processor;

/// <summary>Tells the collector, the moment it happens, that a file appeared
/// in Passport's folder (a test passes its own).</summary>
public interface IOutboxWatcher : IDisposable
{
    /// <summary>False once the watcher failed (the share dropped, its buffer
    /// overflowed): the collector makes a new one.</summary>
    bool Alive { get; }

    /// <summary>The names noticed since the last call.</summary>
    IReadOnlyList<string> TakeNames();

    /// <summary>Completes when a name arrives or the watcher fails, so the
    /// collector wakes at once instead of at its next scan.</summary>
    Task Noticed { get; }
}

/// <summary>
/// A <see cref="FileSystemWatcher"/> on the BOOutbox share, the way the
/// owner's LdPosService catches every file before Modisoft's service moves
/// it away. A watcher on a network share can die without a word (the
/// Passport PC reboots, the SMB session goes stale), so it is never the only
/// way in: <see cref="OutboxCollector"/> still lists the folder every poll.
/// </summary>
public sealed class OutboxWatcher : IOutboxWatcher
{
    /// <summary>Making the watcher touches the share and can hang on a dead
    /// one, so it gets a time limit (LdPosService: 30 s).</summary>
    public static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(30);

    private readonly FileSystemWatcher _watcher;
    private readonly ConcurrentQueue<string> _names = new();
    private readonly object _gate = new();
    private TaskCompletionSource _noticed = NewSignal();
    private volatile bool _alive = true;

    private OutboxWatcher(FileSystemWatcher watcher)
    {
        _watcher = watcher;
        // Created: a new file. Renamed: Passport (or a copy tool) writes a
        // temp name and renames it. Changed: a file rewritten in place.
        _watcher.Created += (_, e) => Add(e.Name);
        _watcher.Renamed += (_, e) => Add(e.Name);
        _watcher.Changed += (_, e) => Add(e.Name);
        _watcher.Error += (_, _) =>
        {
            _alive = false;
            Wake();
        };
    }

    public bool Alive => _alive;

    public Task Noticed
    {
        get
        {
            lock (_gate) return _noticed.Task;
        }
    }

    /// <summary>A running watcher on <paramref name="folder"/>, or null when
    /// it cannot be made in time (the caller tries again later).</summary>
    public static OutboxWatcher? TryStart(string folder, TimeSpan? timeout = null)
    {
        var start = Task.Run(() =>
        {
            var w = new FileSystemWatcher(folder)
            {
                Filter = "*",
                IncludeSubdirectories = false,
                // No DirectoryName: a new subfolder is not a file to send.
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                // 64 KB: room for a burst of files from several registers.
                InternalBufferSize = 64 * 1024,
            };
            try
            {
                w.EnableRaisingEvents = true;
                return w;
            }
            catch
            {
                w.Dispose();
                throw;
            }
        });
        try
        {
            if (!start.Wait(timeout ?? StartTimeout))
            {
                // Throw away a watcher that comes up after we gave up on it.
                _ = start.ContinueWith(t =>
                {
                    if (t.Status == TaskStatus.RanToCompletion) t.Result.Dispose();
                }, TaskScheduler.Default);
                return null;
            }
            return new OutboxWatcher(start.Result);
        }
        catch (AggregateException)
        {
            return null;
        }
    }

    public IReadOnlyList<string> TakeNames()
    {
        lock (_gate)
        {
            if (_noticed.Task.IsCompleted) _noticed = NewSignal();
        }
        var list = new List<string>();
        while (_names.TryDequeue(out var name)) list.Add(name);
        return list;
    }

    private void Add(string? name)
    {
        if (string.IsNullOrEmpty(name)) return;
        _names.Enqueue(name);
        Wake();
    }

    private void Wake()
    {
        lock (_gate) _noticed.TrySetResult();
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Dispose()
    {
        _alive = false;
        try
        {
            _watcher.EnableRaisingEvents = false;
            _watcher.Dispose();
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // A dead share: nothing to release.
        }
        Wake();
    }
}
