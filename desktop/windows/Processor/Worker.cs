namespace DineroBook.Processor.Service;

/// <summary>Runs <see cref="ProcessorEngine"/> cycles until the service
/// stops. Nothing that goes wrong in a cycle stops the loop.</summary>
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
        var engine = new ProcessorEngine(
            paths,
            new FileConfigSource(paths),
            new PassportFolder(),
            (api, key) => new AgentUploader(http, api, key),
            TimeProvider.System,
            log,
            version);

        log.LogInformation("DineroBook Processor {Version} started; its files are in {Folder}.", version, paths.Root);
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                TimeSpan wait;
                try
                {
                    wait = await engine.RunCycleAsync(stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    log.LogError(ex, "Unexpected error; carrying on in {Seconds} seconds.", AfterUnexpectedError.TotalSeconds);
                    wait = AfterUnexpectedError;
                }
                try
                {
                    // Until the next pass is due, or an upload finishes.
                    await engine.WaitAsync(wait, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
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
}
