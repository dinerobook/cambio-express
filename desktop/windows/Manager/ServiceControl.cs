using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using System.ServiceProcess;
using DineroBook.Processor;
using Microsoft.Win32;

namespace DineroBook.Manager;

/// <summary>The account the service runs as. Not a record: the password
/// must never reach a generated ToString.</summary>
internal sealed class ServiceAccount
{
    public const string LocalServiceName = @"NT AUTHORITY\LocalService";

    private ServiceAccount(string name, string? password)
    {
        Name = name;
        Password = password;
    }

    /// <summary>For the Service Control Manager: NT AUTHORITY\LocalService,
    /// DOMAIN\user or .\user.</summary>
    public string Name { get; }

    /// <summary>Handed to Windows when the service is set up, then dropped.
    /// Never stored by us.</summary>
    public string? Password { get; }

    public bool IsLocalService => string.Equals(Name, LocalServiceName, StringComparison.OrdinalIgnoreCase)
                                  || string.Equals(Name, "LocalService", StringComparison.OrdinalIgnoreCase);

    public static ServiceAccount LocalService { get; } = new(LocalServiceName, null);

    /// <summary>A Windows account typed in the Manager: DOMAIN\user,
    /// COMPUTER\user, .\user, user (this computer) or user@domain.</summary>
    public static ServiceAccount Windows(string name, string password)
    {
        var n = name.Trim();
        if (n.Length == 0) throw new ArgumentException("Type the Windows account, like .\\dinerobook or STORE\\dinerobook.");
        if (!n.Contains('\\') && !n.Contains('@')) n = ".\\" + n;
        return new ServiceAccount(n, password);
    }

    public SecurityIdentifier Sid()
    {
        if (IsLocalService) return DataFolderSecurity.LocalService;
        var lookup = Name.StartsWith(@".\", StringComparison.Ordinal) ? Environment.MachineName + Name[1..] : Name;
        return (SecurityIdentifier)new NTAccount(lookup).Translate(typeof(SecurityIdentifier));
    }

    public override string ToString() => Name;
}

/// <summary>
/// Installs, configures and controls the DineroBookProcessor service.
/// Every change needs administrator rights. The program file is copied to
/// Program Files first (a service must never run from a folder ordinary
/// users can write to), and the account password goes to Windows through
/// ChangeServiceConfig, never on a command line.
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
    }

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

    /// <summary>The configured account, or LocalService when not installed.</summary>
    public static ServiceAccount CurrentAccount()
    {
        var info = Query();
        if (!info.Installed || info.Account.Length == 0) return ServiceAccount.LocalService;
        return string.Equals(info.Account, ServiceAccount.LocalServiceName, StringComparison.OrdinalIgnoreCase)
               || string.Equals(info.Account, "LocalService", StringComparison.OrdinalIgnoreCase)
            ? ServiceAccount.LocalService
            : ServiceAccount.Windows(info.Account, "");
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
    /// points it at the new copy, and leaves it stopped. <paramref name="account"/>
    /// null keeps the account it has (LocalService for a new install).</summary>
    public static void InstallOrUpdate(string sourceExe, ServiceAccount? account)
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
                var acct = account ?? ServiceAccount.LocalService;
                var svc = CreateService(scm, Name, DisplayName, SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, imagePath, null, IntPtr.Zero, null,
                    acct.Name, acct.IsLocalService ? "" : acct.Password);
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
                            null, IntPtr.Zero, null, account?.Name, account is null ? null : account.IsLocalService ? "" : account.Password,
                            DisplayName))
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

        var effective = account ?? CurrentAccount();
        if (!effective.IsLocalService) GrantLogOnAsService(effective.Sid());
        RegisterEventSource();

        var after = Query();
        if (!string.Equals(after.ImagePath, imagePath, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"The service points at {after.ImagePath}, not {imagePath}.");
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

    // ── "Log on as a service" for a Windows account ──

    private static void GrantLogOnAsService(SecurityIdentifier sid)
    {
        var attributes = new LSA_OBJECT_ATTRIBUTES { Length = Marshal.SizeOf<LSA_OBJECT_ATTRIBUTES>() };
        var status = LsaOpenPolicy(IntPtr.Zero, ref attributes, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, out var policy);
        if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status), "Could not open the local security policy");
        var right = "SeServiceLogonRight";
        var buffer = Marshal.StringToHGlobalUni(right);
        try
        {
            var rights = new[]
            {
                new LSA_UNICODE_STRING
                {
                    Buffer = buffer,
                    Length = (ushort)(right.Length * 2),
                    MaximumLength = (ushort)((right.Length + 1) * 2),
                },
            };
            var bytes = new byte[sid.BinaryLength];
            sid.GetBinaryForm(bytes, 0);
            status = LsaAddAccountRights(policy, bytes, rights, 1);
            if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status), "Could not let the account log on as a service");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
            LsaClose(policy);
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
    private const uint POLICY_CREATE_ACCOUNT = 0x00000010;
    private const uint POLICY_LOOKUP_NAMES = 0x00000800;

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_OBJECT_ATTRIBUTES
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

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

    [DllImport("advapi32.dll")]
    private static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES objectAttributes, uint desiredAccess, out IntPtr policyHandle);

    [DllImport("advapi32.dll")]
    private static extern uint LsaAddAccountRights(IntPtr policyHandle, byte[] accountSid, LSA_UNICODE_STRING[] userRights, uint countOfRights);

    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr policyHandle);

    [DllImport("advapi32.dll")]
    private static extern int LsaNtStatusToWinError(uint status);
}
