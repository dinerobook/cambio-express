using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.ServiceProcess;
using DineroBook.Processor;
using Microsoft.Win32;

namespace DineroBook.Manager;

/// <summary>
/// Installs, configures and controls the DineroBookProcessor service.
/// Every change needs administrator rights. The program file is copied to
/// Program Files first (a service must never run from a folder ordinary
/// users can write to).
/// <para>
/// It always runs as NetworkService, like the owner's LdPosService: that
/// account reaches the BOOutbox network share as this computer, so nobody
/// types a Windows account name or password. An older install that ran as
/// LocalService or a typed-in account moves to NetworkService on
/// Install / Update.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
internal static class ServiceControl
{
    public const string Name = DataPaths.ServiceName;
    public const string DisplayName = "DineroBook Processor";
    public const string Description =
        "Sends Gilbarco Passport's register files (BOOutbox) to DineroBook. Read only: it never moves, changes or deletes Passport's files.";
    public const string ProcessorExe = "DineroBookProcessor.exe";
    public const string ManagerExe = "DineroBookManager.exe";

    /// <summary>The one account the service runs as. It has no password
    /// (Windows takes an empty one) and may already log on as a service.</summary>
    public const string Account = @"NT AUTHORITY\NetworkService";

    private static readonly TimeSpan WaitFor = TimeSpan.FromSeconds(30);

    public static string InstallFolder => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DineroBook", "Processor");

    public static string InstalledExe => Path.Combine(InstallFolder, ProcessorExe);

    public sealed record Info(bool Installed, ServiceControllerStatus? Status, string Account, string ImagePath)
    {
        public string Describe() => !Installed
            ? "Not installed"
            : Status switch
            {
                ServiceControllerStatus.Running => "Running",
                ServiceControllerStatus.Stopped => "Stopped",
                ServiceControllerStatus.StartPending => "Starting…",
                ServiceControllerStatus.StopPending => "Stopping…",
                null => "Installed",
                var s => s.ToString()!,
            };

        /// <summary>Installed by an older Manager under another account:
        /// Install / Update moves it to NetworkService.</summary>
        public bool NeedsNewAccount => Installed && Account.Length > 0 && !IsNetworkService(Account);
    }

    /// <summary>The Service Control Manager may write the account either way.</summary>
    public static bool IsNetworkService(string account) =>
        string.Equals(account, Account, StringComparison.OrdinalIgnoreCase)
        || string.Equals(account, @"NT AUTHORITY\NETWORK SERVICE", StringComparison.OrdinalIgnoreCase);

    /// <summary>Works without administrator rights.</summary>
    public static Info Query()
    {
        ServiceControllerStatus? status;
        try
        {
            using var sc = new ServiceController(Name);
            status = sc.Status;
        }
        catch (InvalidOperationException)
        {
            return new Info(false, null, "", "");
        }
        using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + Name);
        return new Info(true, status, key?.GetValue("ObjectName") as string ?? "", key?.GetValue("ImagePath") as string ?? "");
    }

    /// <summary>The service's own SID (NT SERVICE\DineroBookProcessor), once
    /// the service exists.</summary>
    public static SecurityIdentifier? ServiceSid()
    {
        try
        {
            return (SecurityIdentifier)new NTAccount("NT SERVICE", Name).Translate(typeof(SecurityIdentifier));
        }
        catch (Exception ex) when (ex is IdentityNotMappedException or SystemException)
        {
            return null;
        }
    }

    /// <summary>Copies the program to Program Files, creates the service or
    /// points it at the new copy (as NetworkService either way), and leaves
    /// it stopped.</summary>
    public static void InstallOrUpdate(string sourceExe)
    {
        if (!File.Exists(sourceExe))
        {
            throw new FileNotFoundException($"Put {ProcessorExe} in the same folder as {ManagerExe}, then try again.", sourceExe);
        }
        var before = Query();
        if (before.Installed) Stop();

        Directory.CreateDirectory(InstallFolder);
        CopyIfDifferent(sourceExe, InstalledExe);
        if (Environment.ProcessPath is { } me && File.Exists(me))
        {
            // A handy copy next to the service; another Manager running
            // from there must not stop the install.
            try
            {
                CopyIfDifferent(me, Path.Combine(InstallFolder, ManagerExe));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }

        var imagePath = "\"" + InstalledExe + "\"";
        var scm = OpenSCManager(null, null, SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE);
        if (scm == IntPtr.Zero) throw Win32("open the Service Control Manager");
        try
        {
            if (!before.Installed)
            {
                var svc = CreateService(scm, Name, DisplayName, SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, imagePath, null, IntPtr.Zero, null, Account, "");
                if (svc == IntPtr.Zero) throw Win32("create the service");
                CloseServiceHandle(svc);
            }
            else
            {
                var svc = OpenService(scm, Name, SERVICE_CHANGE_CONFIG | SERVICE_QUERY_CONFIG);
                if (svc == IntPtr.Zero) throw Win32("open the service");
                try
                {
                    if (!ChangeServiceConfig(svc, SERVICE_NO_CHANGE, SERVICE_AUTO_START, SERVICE_NO_CHANGE, imagePath,
                            null, IntPtr.Zero, null, Account, "", DisplayName))
                    {
                        throw Win32("update the service");
                    }
                }
                finally
                {
                    CloseServiceHandle(svc);
                }
            }
        }
        finally
        {
            CloseServiceHandle(scm);
        }

        // The settings that carry no secret, with Windows' own tool.
        Sc("config", Name, "start=", "delayed-auto");
        Sc("description", Name, Description);
        // Restart after 1 minute, again after 1, then every 5; count afresh daily.
        Sc("failure", Name, "reset=", "86400", "actions=", "restart/60000/restart/60000/restart/300000");
        Sc("failureflag", Name, "1");
        // Gives the service its own SID, so its files can name it alone.
        Sc("sidtype", Name, "unrestricted");
        RegisterEventSource();

        var after = Query();
        if (!string.Equals(after.ImagePath, imagePath, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"The service points at {after.ImagePath}, not {imagePath}.");
        }
        if (!IsNetworkService(after.Account))
        {
            throw new InvalidOperationException($"The service runs as {after.Account}, not {Account}.");
        }
    }

    public static void Start()
    {
        using var sc = new ServiceController(Name);
        if (sc.Status == ServiceControllerStatus.Running) return;
        if (sc.Status != ServiceControllerStatus.StartPending) sc.Start();
        sc.WaitForStatus(ServiceControllerStatus.Running, WaitFor);
    }

    public static void Stop()
    {
        using var sc = new ServiceController(Name);
        if (sc.Status == ServiceControllerStatus.Stopped) return;
        if (sc.Status != ServiceControllerStatus.StopPending) sc.Stop();
        sc.WaitForStatus(ServiceControllerStatus.Stopped, WaitFor);
    }

    public static void Restart()
    {
        Stop();
        Start();
    }

    /// <summary>Stops and removes the service and the program files it
    /// ran from. The data folder (settings, key, ledger, logs) stays.</summary>
    public static void Uninstall()
    {
        if (Query().Installed)
        {
            Stop();
            var scm = OpenSCManager(null, null, SC_MANAGER_CONNECT);
            if (scm == IntPtr.Zero) throw Win32("open the Service Control Manager");
            try
            {
                var svc = OpenService(scm, Name, DELETE);
                if (svc == IntPtr.Zero) throw Win32("open the service");
                try
                {
                    if (!DeleteService(svc) && Marshal.GetLastWin32Error() != ERROR_SERVICE_MARKED_FOR_DELETE)
                    {
                        throw Win32("remove the service");
                    }
                }
                finally
                {
                    CloseServiceHandle(svc);
                }
            }
            finally
            {
                CloseServiceHandle(scm);
            }
        }
        // The process may take a moment to let go of its file.
        for (var i = 0; i < 20 && File.Exists(InstalledExe); i++)
        {
            try
            {
                File.Delete(InstalledExe);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Thread.Sleep(500);
            }
        }
    }

    public static void RegisterEventSource()
    {
        try
        {
            if (!EventLog.SourceExists(DataPaths.EventSource))
            {
                EventLog.CreateEventSource(DataPaths.EventSource, "Application");
            }
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or InvalidOperationException or ArgumentException)
        {
            // Not fatal: the service then writes errors under ".NET Runtime".
        }
    }

    private static void CopyIfDifferent(string from, string to)
    {
        if (string.Equals(Path.GetFullPath(from), Path.GetFullPath(to), StringComparison.OrdinalIgnoreCase)) return;
        File.Copy(from, to, overwrite: true);
    }

    /// <summary>sc.exe from System32 (never from PATH).</summary>
    private static void Sc(params string[] args)
    {
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "sc.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("Could not run sc.exe.");
        var output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0)
        {
            throw new InvalidOperationException($"sc {args[0]} failed ({p.ExitCode}): {output.Trim()}");
        }
    }

    private static Win32Exception Win32(string action)
    {
        var code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, $"Could not {action}: {new Win32Exception(code).Message}");
    }

    // ── advapi32 ──

    private const uint SC_MANAGER_CONNECT = 0x0001;
    private const uint SC_MANAGER_CREATE_SERVICE = 0x0002;
    private const uint SERVICE_QUERY_CONFIG = 0x0001;
    private const uint SERVICE_CHANGE_CONFIG = 0x0002;
    private const uint DELETE = 0x00010000;
    private const uint SERVICE_ALL_ACCESS = 0x000F01FF;
    private const uint SERVICE_WIN32_OWN_PROCESS = 0x00000010;
    private const uint SERVICE_AUTO_START = 0x00000002;
    private const uint SERVICE_ERROR_NORMAL = 0x00000001;
    private const uint SERVICE_NO_CHANGE = 0xFFFFFFFF;
    private const int ERROR_SERVICE_MARKED_FOR_DELETE = 1072;

    [DllImport("advapi32.dll", EntryPoint = "OpenSCManagerW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManager(string? machineName, string? databaseName, uint desiredAccess);

    [DllImport("advapi32.dll", EntryPoint = "CreateServiceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateService(IntPtr scManager, string serviceName, string displayName, uint desiredAccess,
        uint serviceType, uint startType, uint errorControl, string binaryPathName, string? loadOrderGroup, IntPtr tagId,
        string? dependencies, string? serviceStartName, string? password);

    [DllImport("advapi32.dll", EntryPoint = "OpenServiceW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenService(IntPtr scManager, string serviceName, uint desiredAccess);

    [DllImport("advapi32.dll", EntryPoint = "ChangeServiceConfigW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ChangeServiceConfig(IntPtr service, uint serviceType, uint startType, uint errorControl,
        string? binaryPathName, string? loadOrderGroup, IntPtr tagId, string? dependencies, string? serviceStartName,
        string? password, string? displayName);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteService(IntPtr service);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseServiceHandle(IntPtr handle);
}
