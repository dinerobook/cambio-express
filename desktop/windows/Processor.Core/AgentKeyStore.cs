using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace DineroBook.Processor;

/// <summary>
/// The store's agent key on disk: agent-key.bin, encrypted with DPAPI for
/// this computer (LocalMachine scope) plus a fixed entropy, in a file only
/// SYSTEM, Administrators and the service may read. Copied to another
/// computer it does not decrypt. Never the DineroBook password or a sign-in
/// token; never written to a log.
/// </summary>
[SupportedOSPlatform("windows")]
public static class AgentKeyStore
{
    // Not a secret: it ties the encrypted blob to this program, so another
    // program's LocalMachine DPAPI blob cannot be swapped in or read by
    // calling the same API without it.
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("DineroBook Processor agent key v1");

    /// <summary>A key the server could have issued: "pak_" plus URL-safe
    /// characters.</summary>
    public static bool LooksLikeAgentKey(string? key) =>
        key is not null
        && key.Length is > 10 and <= 200
        && key.StartsWith(ServerContract.AgentKeyPrefix, StringComparison.Ordinal)
        && key.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-');

    public static byte[] Protect(string key)
    {
        var plain = Encoding.UTF8.GetBytes(key);
        try
        {
            return ProtectedData.Protect(plain, Entropy, DataProtectionScope.LocalMachine);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    /// <summary>Throws <see cref="CryptographicException"/> when the blob
    /// was made on another computer or changed.</summary>
    public static string Unprotect(byte[] blob)
    {
        var plain = ProtectedData.Unprotect(blob, Entropy, DataProtectionScope.LocalMachine);
        try
        {
            return Encoding.UTF8.GetString(plain);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    /// <summary>
    /// Writes the key. The new file is created with its final permissions
    /// (never readable by anyone else, not even for a moment), then renamed
    /// over the old one.
    /// </summary>
    public static void Save(string path, string key, FileSecurity security)
    {
        if (!LooksLikeAgentKey(key)) throw new ArgumentException("That is not an agent key.", nameof(key));
        var blob = Protect(key);
        var temp = path + ".new";
        if (File.Exists(temp)) File.Delete(temp);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using (var fs = new FileInfo(temp).Create(FileMode.CreateNew, FileSystemRights.Write,
                   FileShare.None, 4096, FileOptions.WriteThrough, security))
        {
            fs.Write(blob, 0, blob.Length);
        }
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>The saved key, or null when none is saved. Throws when the
    /// file cannot be read (permissions) or decrypted (another computer).</summary>
    public static string? Load(string path)
    {
        byte[] blob;
        try
        {
            blob = File.ReadAllBytes(path);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        var key = Unprotect(blob);
        return LooksLikeAgentKey(key) ? key : throw new CryptographicException("The saved agent key is damaged.");
    }

    public static void Delete(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }
}

/// <summary>
/// Permissions for the data folder. Nothing is inherited from ProgramData:
/// <list type="bullet">
/// <item>top folder (settings.json): SYSTEM and Administrators change it;
/// Users and the service read it (the status page works unelevated);</item>
/// <item>agent-key.bin: SYSTEM and Administrators, the service reads it;
/// nobody else;</item>
/// <item>state\ (ledger, status, logs): the service writes it; Users read it.</item>
/// </list>
/// "The service" is both its account (NetworkService) and its own service
/// SID (NT SERVICE\DineroBookProcessor).
/// </summary>
[SupportedOSPlatform("windows")]
public static class DataFolderSecurity
{
    public static SecurityIdentifier LocalSystem => new(WellKnownSidType.LocalSystemSid, null);
    public static SecurityIdentifier Administrators => new(WellKnownSidType.BuiltinAdministratorsSid, null);
    public static SecurityIdentifier Users => new(WellKnownSidType.BuiltinUsersSid, null);
    public static SecurityIdentifier NetworkService => new(WellKnownSidType.NetworkServiceSid, null);

    private const InheritanceFlags Inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;

    public static FileSecurity ForKeyFile(IEnumerable<SecurityIdentifier> readers, bool ownedByAdministrators)
    {
        var s = new FileSecurity();
        s.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        s.AddAccessRule(new FileSystemAccessRule(LocalSystem, FileSystemRights.FullControl, AccessControlType.Allow));
        s.AddAccessRule(new FileSystemAccessRule(Administrators, FileSystemRights.FullControl, AccessControlType.Allow));
        foreach (var r in readers.Distinct())
        {
            s.AddAccessRule(new FileSystemAccessRule(r, FileSystemRights.Read | FileSystemRights.Synchronize, AccessControlType.Allow));
        }
        if (ownedByAdministrators) s.SetOwner(Administrators);
        return s;
    }

    public static DirectorySecurity ForRoot(IEnumerable<SecurityIdentifier> readers, bool ownedByAdministrators)
    {
        var s = Folder(ownedByAdministrators);
        s.AddAccessRule(new FileSystemAccessRule(Users, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, Inherit, PropagationFlags.None, AccessControlType.Allow));
        foreach (var r in readers.Distinct())
        {
            s.AddAccessRule(new FileSystemAccessRule(r, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, Inherit, PropagationFlags.None, AccessControlType.Allow));
        }
        return s;
    }

    public static DirectorySecurity ForState(IEnumerable<SecurityIdentifier> writers, bool ownedByAdministrators)
    {
        var s = Folder(ownedByAdministrators);
        s.AddAccessRule(new FileSystemAccessRule(Users, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, Inherit, PropagationFlags.None, AccessControlType.Allow));
        foreach (var w in writers.Distinct())
        {
            s.AddAccessRule(new FileSystemAccessRule(w, FileSystemRights.Modify | FileSystemRights.Synchronize, Inherit, PropagationFlags.None, AccessControlType.Allow));
        }
        return s;
    }

    private static DirectorySecurity Folder(bool ownedByAdministrators)
    {
        var s = new DirectorySecurity();
        s.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        s.AddAccessRule(new FileSystemAccessRule(LocalSystem, FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));
        s.AddAccessRule(new FileSystemAccessRule(Administrators, FileSystemRights.FullControl, Inherit, PropagationFlags.None, AccessControlType.Allow));
        if (ownedByAdministrators) s.SetOwner(Administrators);
        return s;
    }

    /// <summary>Creates the folders and sets their permissions (and the key
    /// file's, when it exists). Run elevated for the machine's own folder.</summary>
    public static void Apply(DataPaths paths, IReadOnlyCollection<SecurityIdentifier> service, bool ownedByAdministrators)
    {
        var root = Directory.CreateDirectory(paths.Root);
        root.SetAccessControl(ForRoot(service, ownedByAdministrators));
        var state = Directory.CreateDirectory(paths.State);
        state.SetAccessControl(ForState(service, ownedByAdministrators));
        Directory.CreateDirectory(paths.Logs);
        if (File.Exists(paths.AgentKey))
        {
            new FileInfo(paths.AgentKey).SetAccessControl(ForKeyFile(service, ownedByAdministrators));
        }
    }
}
