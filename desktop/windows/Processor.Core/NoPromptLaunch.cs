using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;
using System.Text;

namespace DineroBook.Processor;

/// <summary>
/// Opens DineroBook Manager with administrator rights without the Windows
/// prompt, the way the owner's LdPosService does it
/// (<c>Disable-RunExeAsAdmin.bat</c>). Install / Update registers a scheduled
/// task that starts the Manager "with highest privileges", and puts a
/// "DineroBook Manager" shortcut on the desktop that runs that task. UAC is
/// left alone, and nothing else on the PC changes.
/// <list type="bullet">
/// <item>The task starts only the Manager's copy in Program Files. Only
/// administrators can change that folder, so nobody can swap in another
/// program, or plant a file beside it, to run with administrator rights.
/// ProgramData would not do: every user may add files there.</item>
/// <item>The task takes no arguments from whoever starts it; it always
/// passes <see cref="FromTaskOption"/>, so a Manager it starts never sends
/// itself round again.</item>
/// <item>It belongs to the Windows user who clicked Install / Update. Anyone
/// else gets the usual prompt.</item>
/// </list>
/// </summary>
[SupportedOSPlatform("windows")]
public static class NoPromptLaunch
{
    public const string TaskName = @"DineroBook\Manager";
    public const string ShortcutName = "DineroBook Manager.lnk";
    public const string FromTaskOption = "--from-task";

    private static readonly TimeSpan SchtasksTimeout = TimeSpan.FromSeconds(20);

    public static string Schtasks => Path.Combine(Environment.SystemDirectory, "schtasks.exe");

    /// <summary>The shortcut on every user's desktop.</summary>
    public static string DesktopShortcut => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), ShortcutName);

    /// <summary><c>schtasks</c> arguments that (re)create the task. ONCE at a
    /// time already past: it never starts by itself, only from the shortcut.
    /// /RL HIGHEST: with administrator rights. /IT: only while the person is
    /// signed in (it is a window).</summary>
    public static IReadOnlyList<string> CreateArguments(string managerExe) =>
    [
        "/Create", "/F", "/TN", TaskName,
        "/TR", "\"" + managerExe + "\" " + FromTaskOption,
        "/SC", "ONCE", "/ST", "00:00", "/RL", "HIGHEST", "/IT",
    ];

    public static IReadOnlyList<string> RunArguments => ["/Run", "/TN", TaskName];

    public static IReadOnlyList<string> DeleteArguments => ["/Delete", "/F", "/TN", TaskName];

    /// <summary>The shortcut's arguments to <c>schtasks.exe</c>.</summary>
    public static string ShortcutArguments => "/Run /TN \"" + TaskName + "\"";

    /// <summary>Registers the task and the desktop shortcut (administrator
    /// rights needed). <paramref name="managerExe"/> is the Manager's copy in
    /// Program Files.</summary>
    /// <exception cref="InvalidOperationException">schtasks refused.</exception>
    public static void Register(string managerExe)
    {
        Execute(CreateArguments(managerExe), "register the no-prompt start");
        WriteShortcut(DesktopShortcut, Schtasks, ShortcutArguments, managerExe,
            Path.GetDirectoryName(managerExe) ?? "",
            "Opens DineroBook Manager with administrator rights, without the Windows prompt");
    }

    /// <summary>Removes the task and the shortcut; either may already be gone.</summary>
    public static void Remove()
    {
        try
        {
            Execute(DeleteArguments, "remove the no-prompt start");
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            // Not registered, or registered by another user.
        }
        try
        {
            File.Delete(DesktopShortcut);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>Starts the Manager through the task. False when there is no
    /// task for this Windows user (the caller then asks Windows the usual way).</summary>
    public static bool TryStart()
    {
        try
        {
            Execute(RunArguments, "start DineroBook Manager");
            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            return false;
        }
    }

    private static void Execute(IReadOnlyList<string> arguments, string what)
    {
        var start = new ProcessStartInfo(Schtasks)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in arguments) start.ArgumentList.Add(a);
        using var p = Process.Start(start) ?? throw new InvalidOperationException($"Could not {what}: schtasks did not start.");
        var stderr = p.StandardError.ReadToEndAsync();
        _ = p.StandardOutput.ReadToEndAsync();
        if (!p.WaitForExit(SchtasksTimeout))
        {
            try { p.Kill(); } catch (InvalidOperationException) { }
            throw new InvalidOperationException($"Could not {what}: schtasks did not answer in time.");
        }
        if (p.ExitCode != 0)
        {
            var why = stderr.Wait(TimeSpan.FromSeconds(2)) ? stderr.Result.Trim() : "";
            throw new InvalidOperationException($"Could not {what}" + (why.Length > 0 ? ": " + why : "."));
        }
    }

    // ── The .lnk file (Windows' own shell link object) ──

    /// <summary>Writes a shortcut. <paramref name="showMinimized"/>: the
    /// console of schtasks.exe flashes by minimised.</summary>
    public static void WriteShortcut(string path, string target, string arguments, string iconFile,
        string workingFolder, string description, bool showMinimized = true)
    {
        var link = (IShellLinkW)new ShellLink();
        try
        {
            link.SetPath(target);
            link.SetArguments(arguments);
            link.SetWorkingDirectory(workingFolder);
            link.SetIconLocation(iconFile, 0);
            link.SetDescription(description);
            link.SetShowCmd(showMinimized ? SwShowMinNoActive : SwShowNormal);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            ((IPersistFile)link).Save(path, true);
        }
        finally
        {
            Marshal.FinalReleaseComObject(link);
        }
    }

    /// <summary>What a shortcut starts (target, arguments, icon file).</summary>
    public static (string Target, string Arguments, string Icon) ReadShortcut(string path)
    {
        var link = (IShellLinkW)new ShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 0);
            var target = new StringBuilder(1024);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            var args = new StringBuilder(1024);
            link.GetArguments(args, args.Capacity);
            var icon = new StringBuilder(1024);
            link.GetIconLocation(icon, icon.Capacity, out _);
            return (target.ToString(), args.ToString(), icon.ToString());
        }
        finally
        {
            Marshal.FinalReleaseComObject(link);
        }
    }

    private const int SwShowNormal = 1;
    private const int SwShowMinNoActive = 7;

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink;

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
        void Resolve(IntPtr hwnd, int fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }
}
