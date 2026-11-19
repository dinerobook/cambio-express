using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging.EventLog;

namespace DineroBook.Processor.Service;

/// <summary>
/// DineroBookProcessor.exe. Started by Windows as the DineroBookProcessor
/// service (DineroBook Manager installs it), or by hand for testing:
/// <code>
/// DineroBookProcessor.exe --console [--data-dir C:\some\test\folder]
/// </code>
/// It opens no network port: the Manager reads state\status.json.
/// </summary>
internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var console = args.Any(a => string.Equals(a, "--console", StringComparison.OrdinalIgnoreCase));
        var asService = WindowsServiceHelpers.IsWindowsService();
        if (!console && !asService)
        {
            Console.WriteLine("DineroBook Processor runs as a Windows service.");
            Console.WriteLine("Install and control it with DineroBook Manager (DineroBookManager.exe).");
            Console.WriteLine("To try it in this window:  DineroBookProcessor.exe --console [--data-dir <folder>]");
            if (!Console.IsInputRedirected && Environment.UserInteractive)
            {
                Console.WriteLine("Press Enter to close.");
                Console.ReadLine();
            }
            return 2;
        }

        var paths = DataPaths.FromArgs(args);
        using var fileLog = new RollingFileLoggerProvider(paths.Logs);
        var host = Host.CreateDefaultBuilder() // no args: our flags are not configuration
            .UseContentRoot(AppContext.BaseDirectory)
            .UseWindowsService(o => o.ServiceName = DataPaths.ServiceName)
            .ConfigureLogging(logging =>
            {
                logging.ClearProviders();
                logging.SetMinimumLevel(LogLevel.Information);
                logging.AddFilter("Microsoft", LogLevel.Warning);
                logging.AddProvider(fileLog);
                if (console)
                {
                    logging.AddSimpleConsole(o =>
                    {
                        o.SingleLine = true;
                        o.TimestampFormat = "HH:mm:ss ";
                    });
                }
                if (asService)
                {
                    logging.AddEventLog(new EventLogSettings
                    {
                        SourceName = DataPaths.EventSource,
                        LogName = "Application",
                        Filter = (_, level) => level >= LogLevel.Error,
                    });
                }
            })
            .ConfigureServices(services =>
            {
                services.AddSingleton(paths);
                services.AddHostedService<Worker>();
                services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(20));
            })
            .Build();

        try
        {
            await host.RunAsync();
            return 0;
        }
        catch (Exception ex)
        {
            // Non-zero so Windows' recovery settings restart the service.
            Console.Error.WriteLine("DineroBook Processor stopped: " + ex.Message);
            return 1;
        }
    }
}
