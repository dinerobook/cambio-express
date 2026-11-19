using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

public class AgentKeyStoreTests
{
    private const string Key = "pak_Abc-DEF_0123456789abcdefghijklmnopqrstuvwxyz";

    private static SecurityIdentifier Me => WindowsIdentity.GetCurrent().User!;

    [Fact]
    public void DPAPI_round_trip()
    {
        var blob = AgentKeyStore.Protect(Key);
        Assert.DoesNotContain("pak_", System.Text.Encoding.UTF8.GetString(blob));
        Assert.Equal(Key, AgentKeyStore.Unprotect(blob));
    }

    [Fact]
    public void A_blob_made_without_the_programs_entropy_does_not_open()
    {
        var other = ProtectedData.Protect(System.Text.Encoding.UTF8.GetBytes(Key), null, DataProtectionScope.LocalMachine);
        Assert.ThrowsAny<CryptographicException>(() => AgentKeyStore.Unprotect(other));
    }

    [Fact]
    public void A_changed_blob_does_not_open()
    {
        var blob = AgentKeyStore.Protect(Key);
        blob[^5] ^= 0xFF;
        Assert.ThrowsAny<CryptographicException>(() => AgentKeyStore.Unprotect(blob));
    }

    [Fact]
    public void Saves_and_loads_the_key_file()
    {
        using var dir = new TempDir();
        var path = dir.File("agent-key.bin");
        Assert.Null(AgentKeyStore.Load(path));
        AgentKeyStore.Save(path, Key, DataFolderSecurity.ForKeyFile([Me], ownedByAdministrators: false));
        Assert.Equal(Key, AgentKeyStore.Load(path));
        Assert.DoesNotContain("pak_", System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(path)));

        // Saving again replaces it.
        const string next = "pak_SECOND_0123456789abcdefghijklmnopqrstuvwxyz";
        AgentKeyStore.Save(path, next, DataFolderSecurity.ForKeyFile([Me], ownedByAdministrators: false));
        Assert.Equal(next, AgentKeyStore.Load(path));
        Assert.False(File.Exists(path + ".new"));
    }

    [Fact]
    public void The_key_file_admits_only_SYSTEM_Administrators_and_the_service()
    {
        using var dir = new TempDir();
        var path = dir.File("agent-key.bin");
        var service = new SecurityIdentifier(WellKnownSidType.LocalServiceSid, null);
        AgentKeyStore.Save(path, Key, DataFolderSecurity.ForKeyFile([service, Me], ownedByAdministrators: false));

        var acl = new FileInfo(path).GetAccessControl();
        Assert.True(acl.AreAccessRulesProtected, "nothing may be inherited from the folder");
        var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList();
        Assert.All(rules, r => Assert.Equal(AccessControlType.Allow, r.AccessControlType));
        Assert.All(rules, r => Assert.False(r.IsInherited));
        var who = rules.Select(r => r.IdentityReference).Cast<SecurityIdentifier>().ToHashSet();
        Assert.Equal(new HashSet<SecurityIdentifier>
        {
            DataFolderSecurity.LocalSystem, DataFolderSecurity.Administrators, service, Me,
        }, who);
        var serviceRule = rules.Single(r => r.IdentityReference.Equals(service));
        Assert.Equal(0, (int)(serviceRule.FileSystemRights & (FileSystemRights.WriteData | FileSystemRights.Delete | FileSystemRights.ChangePermissions)));
        Assert.DoesNotContain(rules, r => r.IdentityReference.Equals(DataFolderSecurity.Users));
    }

    [Fact]
    public void Folder_permissions_let_users_read_and_only_the_service_write_state()
    {
        var service = new SecurityIdentifier(WellKnownSidType.LocalServiceSid, null);
        var root = DataFolderSecurity.ForRoot([service], ownedByAdministrators: false);
        var state = DataFolderSecurity.ForState([service], ownedByAdministrators: false);
        Assert.True(root.AreAccessRulesProtected);
        Assert.True(state.AreAccessRulesProtected);

        FileSystemRights RightsOf(DirectorySecurity s, SecurityIdentifier sid) =>
            s.GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>()
                .Where(r => r.IdentityReference.Equals(sid)).Aggregate((FileSystemRights)0, (a, r) => a | r.FileSystemRights);

        Assert.Equal(0, (int)(RightsOf(root, service) & FileSystemRights.WriteData));
        Assert.Equal(0, (int)(RightsOf(root, DataFolderSecurity.Users) & FileSystemRights.WriteData));
        Assert.NotEqual(0, (int)(RightsOf(state, service) & FileSystemRights.WriteData));
        Assert.Equal(0, (int)(RightsOf(state, DataFolderSecurity.Users) & FileSystemRights.WriteData));
        Assert.NotEqual(0, (int)(RightsOf(state, DataFolderSecurity.Users) & FileSystemRights.ReadData));
    }

    [Theory]
    [InlineData("pak_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG", true)]
    [InlineData("pak_short", false)]
    [InlineData("xyz_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG", false)]
    [InlineData("pak_0123456789 abcdefghijklmnopqrstuvwxyz", false)]
    [InlineData("pak_0123456789abcdefghij\nklmnopqrstuvwxyz", false)]
    [InlineData(null, false)]
    public void Only_a_real_looking_agent_key_is_saved(string? key, bool ok)
    {
        Assert.Equal(ok, AgentKeyStore.LooksLikeAgentKey(key));
    }
}

public class ApiAddressTests
{
    [Theory]
    [InlineData("https://dinerobook.com", "https://dinerobook.com/")]
    [InlineData("https://dinerobook.com/", "https://dinerobook.com/")]
    [InlineData("  https://DineroBook.com  ", "https://dinerobook.com/")]
    [InlineData("https://staging.dinerobook.com:8443", "https://staging.dinerobook.com:8443/")]
    [InlineData("http://localhost:5077", "http://localhost:5077/")]
    [InlineData("http://127.0.0.1:5077", "http://127.0.0.1:5077/")]
    [InlineData("http://[::1]:5077", "http://[::1]:5077/")]
    public void Accepts_https_or_a_test_server_on_this_computer(string text, string expected)
    {
        Assert.True(ApiAddress.TryParse(text, out var u, out var error), error);
        Assert.Equal(expected, u.ToString());
    }

    [Theory]
    [InlineData("http://dinerobook.com")]
    [InlineData("http://192.168.1.20:5000")]
    [InlineData("file:///C:/x")]
    [InlineData("ftp://dinerobook.com")]
    [InlineData("dinerobook.com")]
    [InlineData("https://dinerobook.com/app")]
    [InlineData("https://dinerobook.com/?x=1")]
    [InlineData("https://user:pw@dinerobook.com")]
    [InlineData("")]
    [InlineData(null)]
    public void Refuses_everything_else(string? text)
    {
        Assert.False(ApiAddress.TryParse(text, out _, out var error));
        Assert.NotEqual("", error);
    }

    [Fact]
    public void Combines_server_paths()
    {
        ApiAddress.TryParse("https://dinerobook.com", out var u, out _);
        Assert.Equal("https://dinerobook.com/api/v2/posimport/agent/upload", ApiAddress.Combine(u, ServerContract.UploadPath).ToString());
    }
}

public class ProcessorSettingsTests
{
    [Fact]
    public void Defaults()
    {
        var s = ProcessorSettings.Parse(null, out var problem);
        Assert.Equal("", problem);
        Assert.Equal("https://dinerobook.com", s.ApiUrl);
        Assert.Equal(@"C:\Passport\XMLGateway\BOOutbox", s.WatchFolder);
        Assert.Equal(5, s.EffectivePollSeconds);
        Assert.Equal(ProcessorSettings.DefaultPatterns, s.EffectivePatterns);
    }

    [Fact]
    public void Round_trips_through_json()
    {
        var s = new ProcessorSettings
        {
            ApiUrl = "http://localhost:5077",
            WatchFolder = @"\\BOPC\BOOutbox",
            StoreId = 7,
            StoreName = "Main St",
            KeyId = 3,
            KeyLabel = "PC – DineroBook Processor",
            ConnectedBy = "owner@example.com",
            ConnectedAt = new DateTimeOffset(2026, 11, 18, 10, 0, 0, TimeSpan.Zero),
        };
        var back = ProcessorSettings.Parse(s.ToJson(), out _);
        Assert.Equal(s.ApiUrl, back.ApiUrl);
        Assert.Equal(s.WatchFolder, back.WatchFolder);
        Assert.Equal(7, back.StoreId);
        Assert.Equal("Main St", back.StoreName);
        Assert.Equal(3, back.KeyId);
        Assert.Equal(s.ConnectedAt, back.ConnectedAt);
        Assert.DoesNotContain("pak_", s.ToJson());
    }

    [Fact]
    public void Broken_json_is_the_defaults_plus_a_problem()
    {
        var s = ProcessorSettings.Parse("{not json", out var problem);
        Assert.Equal(ProcessorSettings.DefaultWatchFolder, s.WatchFolder);
        Assert.Contains("settings.json", problem);
    }

    [Theory]
    [InlineData("""{"patterns":[]}""")]
    [InlineData("""{"patterns":["..\\*.xml"]}""")]
    [InlineData("""{"patterns":["PJR*.xml", null]}""")]
    public void Odd_patterns_fall_back_to_the_default_list(string json)
    {
        Assert.Equal(ProcessorSettings.DefaultPatterns, ProcessorSettings.Parse(json, out _).EffectivePatterns);
    }

    [Theory]
    [InlineData(0, 2)]
    [InlineData(5, 5)]
    [InlineData(100000, 300)]
    public void The_poll_is_kept_sensible(int seconds, int effective)
    {
        Assert.Equal(effective, new ProcessorSettings { PollSeconds = seconds }.EffectivePollSeconds);
    }

    [Fact]
    public void Data_dir_comes_from_the_command_line()
    {
        var p = DataPaths.FromArgs(["--console", "--data-dir", @"C:\test\proc"]);
        Assert.True(p.IsCustom);
        Assert.Equal(@"C:\test\proc\agent-key.bin", p.AgentKey);
        Assert.Equal(@"C:\test\proc\state\sent.txt", p.SentLedger);
        Assert.False(DataPaths.FromArgs(["--console"]).IsCustom);
        Assert.EndsWith(@"DineroBook\Processor", DataPaths.FromArgs([]).Root);
    }
}

public class FileConfigSourceTests
{
    private const string Key = "pak_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

    [Fact]
    public void Says_not_signed_in_until_a_key_is_saved_then_picks_it_up()
    {
        using var dir = new TempDir();
        var paths = new DataPaths(dir.Path, isCustom: true);
        var source = new FileConfigSource(paths);
        var first = source.Current(out var changed);
        Assert.True(changed);
        Assert.Equal(ProcessorState.NotSignedIn, first.State);
        source.Current(out changed);
        Assert.False(changed);

        AgentKeyStore.Save(paths.AgentKey, Key, DataFolderSecurity.ForKeyFile([WindowsIdentity.GetCurrent().User!], false));
        var next = source.Current(out changed);
        Assert.True(changed);
        Assert.True(next.CanRun);
        Assert.Equal(Key, next.AgentKey);
        Assert.DoesNotContain("pak_", next.ToString());
    }

    [Fact]
    public void A_settings_address_that_is_not_https_stops_it()
    {
        using var dir = new TempDir();
        var paths = new DataPaths(dir.Path, isCustom: true);
        new ProcessorSettings { ApiUrl = "http://dinerobook.com" }.Save(paths);
        var cfg = new FileConfigSource(paths).Current(out _);
        Assert.Equal(ProcessorState.SettingsInvalid, cfg.State);
        Assert.False(cfg.CanRun);
    }

    [Fact]
    public void A_key_from_another_computer_says_so()
    {
        using var dir = new TempDir();
        var paths = new DataPaths(dir.Path, isCustom: true);
        File.WriteAllBytes(paths.AgentKey, [1, 2, 3, 4]);
        var cfg = new FileConfigSource(paths).Current(out _);
        Assert.Equal(ProcessorState.KeyUnreadable, cfg.State);
    }
}
