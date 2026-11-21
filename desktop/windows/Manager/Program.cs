using DineroBook.Processor;

namespace DineroBook.Manager;

internal static class Program
{
    /// <summary>
    /// DineroBookManager.exe [--data-dir C:\some\test\folder]
    /// <para>--data-dir points the Manager at a test folder instead of
    /// %ProgramData%\DineroBook\Processor (use the same one for
    /// DineroBookProcessor.exe --console).</para>
    /// <para>The copy in Program Files, opened without administrator rights,
    /// starts itself again through the no-prompt task when Install / Update
    /// made one (<see cref="NoPromptLaunch"/>); the task passes
    /// <c>--from-task</c>, so that one never goes round again.</para>
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 0 && !Elevation.IsElevated && IsInstalledCopy && NoPromptLaunch.TryStart())
        {
            return;
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(DataPaths.FromArgs(args), args));
    }

    /// <summary>This is the Manager's copy in Program Files, the one the
    /// no-prompt task starts.</summary>
    public static bool IsInstalledCopy =>
        string.Equals(Environment.ProcessPath, ServiceControl.InstalledManagerExe, StringComparison.OrdinalIgnoreCase);
}
