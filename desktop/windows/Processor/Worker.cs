namespace DineroBook.Processor.Service;

/// <summary>
/// Runs two loops side by side until the service stops:
/// <list type="number">
/// <item><see cref="OutboxCollector"/> copies each file from Passport's
/// BOOutbox share into this computer's inbox the moment it is complete
/// (and deletes the original only when "Delete files from XMLGateway" is
/// ticked);</item>
/// <item><see cref="ProcessorEngine"/> sends the inbox to DineroBook and
/// deletes each inbox copy once the server has it.</item>
/// </list>
/// Nothing that goes wrong in a pass stops either loop.
/// </summary>
internal sealed class Worker(DataPaths paths, ILogger<Worker> log) : BackgroundService
{
    private static readonly TimeSpan AfterUnexpectedError = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var version = typeof(Worker).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        // One client for the life of the service, shared by every upload:
        // one connection pool, and a long timeout for a 4 MB file on a slow
        // store connection.
        using var http = Http.Create(Http.UserAgent("dinerobook-processor", typeof(Worker).Assembly), TimeSpan.FromMinutes(2));

        ProcessorEngine? engine = null;
        using var collector = new OutboxCollector(
            paths,
            new FileConfigSource(paths),
            new PassportFolder(),
            TimeProvider.System,
            log,
            watcherFor: folder => OutboxWatcher.TryStart(folder),
            onCopied: () => engine?.Nudge());
        engine = new ProcessorEngine(
            paths,
            new FileConfigSource(paths),
            new PassportFolder(),
            (api, key) => new AgentUploader(http, api, key),
            TimeProvider.System,
            log,
            version,
            inbox: paths.Inbox,
            onFinished: name => File.Delete(Path.Combine(paths.Inbox, name)),
            source: () => new ProcessorEngine.SourceInfo(collector.Problem, collector.MissedCount));

        log.LogInformation("DineroBook Processor {Version} started; its files are in {Folder}.", version, paths.Root);
        try
        {
            await Task.WhenAll(
                Loop("collect", collector.RunOnce, wait => WaitForCollector(collector, wait, stoppingToken), stoppingToken),
                Loop("send", () => engine.RunCycleAsync(stoppingToken).GetAwaiter().GetResult(),
                    wait => engine.WaitAsync(wait, stoppingToken), stoppingToken));
        }
        finally
        {
            // Uploads in flight were told to stop; record the ones that
            // made it (the rest go again next time and come back
            // "duplicate" if the server had them).
            await engine.DrainAsync(TimeSpan.FromSeconds(10));
            engine.Stopped();
            log.LogInformation("DineroBook Processor stopped.");
        }
    }

    /// <summary>Until the next pass is due, or the watcher notices a file.</summary>
    private static async Task WaitForCollector(OutboxCollector collector, TimeSpan wait, CancellationToken ct)
    {
        if (wait <= TimeSpan.Zero) return;
        await Task.WhenAny(Task.Delay(wait, ct), collector.Noticed).ConfigureAwait(false);
        ct.ThrowIfCancellationRequested();
    }

    private async Task Loop(string name, Func<TimeSpan> pass, Func<TimeSpan, Task> waitFor, CancellationToken ct)
    {
        // Each loop on its own thread: a pass that blocks on a dead share
        // (up to its time limit) never holds up the other loop.
        await Task.Yield();
        while (!ct.IsCancellationRequested)
        {
            TimeSpan wait;
            try
            {
                wait = await Task.Run(pass, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Unexpected error ({Loop}); carrying on in {Seconds} seconds.", name, AfterUnexpectedError.TotalSeconds);
                wait = AfterUnexpectedError;
            }
            try
            {
                await waitFor(wait).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}
