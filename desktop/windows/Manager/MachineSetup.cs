using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.Versioning;
using System.Security.Principal;
using DineroBook.Processor;
using DineroBook.Processor.SignIn;

namespace DineroBook.Manager;

/// <summary>Is this Manager running as administrator, and how to ask for it.</summary>
[SupportedOSPlatform("windows")]
internal static class Elevation
{
    public static bool IsElevated
    {
        get
        {
            using var id = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
        }
    }

    /// <summary>Starts this Manager again as administrator (Windows asks).
    /// False when the person said no.</summary>
    public static bool RestartElevated(IReadOnlyList<string> args)
    {
        try
        {
            Process.Start(new ProcessStartInfo(Environment.ProcessPath!)
            {
                UseShellExecute = true,
                Verb = "runas",
                Arguments = string.Join(" ", args.Select(Quote)),
            });
            return true;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            return false;
        }
    }

    private static string Quote(string a) => a.Length > 0 && !a.Any(c => char.IsWhiteSpace(c) || c == '"') ? a : "\"" + a.Replace("\"", "\\\"") + "\"";
}

/// <summary>
/// The Manager's writes to the data folder: settings.json and the agent
/// key, with the folder's permissions. For the machine's own folder
/// (ProgramData) this needs administrator rights. A <c>--data-dir</c> test
/// folder is left with its normal permissions, and its key file also admits
/// the person running the Manager, so a <c>--console</c> Processor started
/// by the same person can read it.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class MachineSetup(DataPaths paths)
{
    public DataPaths Paths => paths;

    /// <summary>Sign-in and settings may be saved from here.</summary>
    public bool CanWrite => paths.IsCustom || Elevation.IsElevated;

    /// <summary>Who besides SYSTEM and Administrators reads the key: the
    /// service's account and its own service SID.</summary>
    public IReadOnlyList<SecurityIdentifier> ServiceIdentities()
    {
        var list = new List<SecurityIdentifier>();
        try
        {
            list.Add(ServiceControl.CurrentAccount().Sid());
        }
        catch (Exception ex) when (ex is IdentityNotMappedException or SystemException)
        {
            // An account that no longer exists: SYSTEM / Administrators only.
        }
        if (ServiceControl.ServiceSid() is { } service) list.Add(service);
        if (paths.IsCustom && WindowsIdentity.GetCurrent().User is { } me) list.Add(me);
        return list.Distinct().ToList();
    }

    /// <summary>Creates the folders and (machine folder only) sets their
    /// permissions.</summary>
    public void SecureFolder()
    {
        if (paths.IsCustom)
        {
            Directory.CreateDirectory(paths.Root);
            Directory.CreateDirectory(paths.State);
            return;
        }
        RequireElevation();
        DataFolderSecurity.Apply(paths, ServiceIdentities(), ownedByAdministrators: true);
    }

    public ProcessorSettings LoadSettings() => ProcessorSettings.Load(paths, out _);

    public void SaveSettings(ProcessorSettings settings)
    {
        RequireWrite();
        SecureFolder();
        settings.Save(paths);
    }

    /// <summary>Saves a newly issued key, then records which store it is.</summary>
    public void SaveKey(IssuedKey key, ConnectedStore store)
    {
        RequireWrite();
        SecureFolder();
        AgentKeyStore.Save(paths.AgentKey, key.Key,
            DataFolderSecurity.ForKeyFile(ServiceIdentities(), ownedByAdministrators: !paths.IsCustom));
        var settings = LoadSettings();
        settings.StoreId = store.StoreId;
        settings.StoreName = store.StoreName;
        settings.KeyId = key.Id;
        settings.KeyLabel = key.Label;
        settings.ConnectedBy = store.ConnectedBy;
        settings.ConnectedAt = DateTimeOffset.Now;
        settings.Save(paths);
    }

    /// <summary>The saved key (for Test connection). Null when none.</summary>
    public string? LoadKey()
    {
        RequireWrite();
        return AgentKeyStore.Load(paths.AgentKey);
    }

    public void ForgetKey()
    {
        RequireWrite();
        AgentKeyStore.Delete(paths.AgentKey);
        var settings = LoadSettings();
        settings.StoreId = null;
        settings.StoreName = "";
        settings.KeyId = null;
        settings.KeyLabel = "";
        settings.ConnectedBy = "";
        settings.ConnectedAt = null;
        settings.Save(paths);
    }

    private void RequireWrite()
    {
        if (!CanWrite) throw new UnauthorizedAccessException("This needs administrator rights: choose Restart as administrator.");
    }

    private static void RequireElevation()
    {
        if (!Elevation.IsElevated) throw new UnauthorizedAccessException("This needs administrator rights: choose Restart as administrator.");
    }

    /// <summary>The adapter the sign-in flow saves through.</summary>
    public IKeySink Sink() => new KeySink(this);

    private sealed class KeySink(MachineSetup setup) : IKeySink
    {
        public void Save(IssuedKey key, ConnectedStore store) => setup.SaveKey(key, store);
    }
}
