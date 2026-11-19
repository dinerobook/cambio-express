using DineroBook.Processor;

namespace DineroBook.Manager;

internal static class Program
{
    /// <summary>
    /// DineroBookManager.exe [--data-dir C:\some\test\folder]
    /// <para>--data-dir points the Manager at a test folder instead of
    /// %ProgramData%\DineroBook\Processor (use the same one for
    /// DineroBookProcessor.exe --console).</para>
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(DataPaths.FromArgs(args), args));
    }
}
