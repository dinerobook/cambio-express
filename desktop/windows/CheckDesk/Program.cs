namespace DineroBook.CheckDesk;

internal static class Program
{
    /// <summary>One window per computer: a second start just ends.</summary>
    [STAThread]
    private static void Main(string[] args)
    {
        using var single = new Mutex(true, "DineroBookCheckDesk", out var first);
        if (!first) return;

        ApplicationConfiguration.Initialize();
        var folder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DineroBook", "CheckDesk");
        Directory.CreateDirectory(folder);
        var settingsFile = Path.Combine(folder, "settings.json");
        var settings = AppSettings.Load(File.Exists(settingsFile) ? File.ReadAllText(settingsFile) : null);
        var demo = settings.DemoScanner || args.Contains("--demo-scanner");

        IScanner scanner = demo ? new DemoScanner() : new ExcellaScanner(settings.DocFeed);
        try
        {
            Application.Run(new MainForm(settings, scanner, Path.Combine(folder, "WebView2")));
        }
        finally
        {
            (scanner as IDisposable)?.Dispose();
        }
    }
}
