using System.Security.Cryptography;

namespace DineroBook.Processor;

/// <summary>What the engine runs with. <see cref="State"/> is empty when it
/// can run; otherwise it is the <see cref="ProcessorState"/> that explains
/// why not, with <see cref="Problem"/> in words. A class, not a record: a
/// record's generated ToString would print the key.</summary>
public sealed class EngineConfig(ProcessorSettings settings, Uri? apiBase, string? agentKey, string state, string problem)
{
    public ProcessorSettings Settings { get; } = settings;
    public Uri? ApiBase { get; } = apiBase;
    public string? AgentKey { get; } = agentKey;
    public string State { get; } = state;
    public string Problem { get; } = problem;

    public bool CanRun => State.Length == 0 && ApiBase is not null && AgentKey is not null;

    public override string ToString() => $"EngineConfig({State}, {ApiBase}, key {(AgentKey is null ? "missing" : "present")})";
}

public interface IConfigSource
{
    /// <summary>The current settings and key; <paramref name="changed"/> is
    /// true when they differ from the previous call.</summary>
    EngineConfig Current(out bool changed);
}

/// <summary>
/// settings.json and agent-key.bin, read again whenever either file changes,
/// so "Sign in again" or a new Passport folder takes effect within one poll
/// without restarting the service.
/// </summary>
public sealed class FileConfigSource(DataPaths paths) : IConfigSource
{
    private (Stamp Settings, Stamp Key)? _stamps;
    private EngineConfig? _current;

    private readonly record struct Stamp(bool Exists, long Length, DateTime Write);

    private static Stamp StampOf(string path)
    {
        try
        {
            var fi = new FileInfo(path);
            return fi.Exists ? new Stamp(true, fi.Length, fi.LastWriteTimeUtc) : default;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return default;
        }
    }

    public EngineConfig Current(out bool changed)
    {
        var stamps = (StampOf(paths.Settings), StampOf(paths.AgentKey));
        if (_current is not null && _stamps == stamps)
        {
            changed = false;
            return _current;
        }
        var next = Load();
        changed = true;
        _current = next;
        // A read that failed for a passing reason (the Manager replacing the
        // file at that moment) is tried again on the next call.
        _stamps = next.State == ProcessorState.KeyUnreadable && next.Problem.StartsWith("Busy", StringComparison.Ordinal)
            ? null
            : stamps;
        return next;
    }

    private EngineConfig Load()
    {
        var settings = ProcessorSettings.Load(paths, out var settingsProblem);
        if (!ApiAddress.TryParse(settings.ApiUrl, out var apiBase, out var addressError))
        {
            return new EngineConfig(settings, null, null, ProcessorState.SettingsInvalid,
                "settings.json: " + addressError);
        }
        string? key;
        try
        {
            key = AgentKeyStore.Load(paths.AgentKey);
        }
        catch (CryptographicException)
        {
            return new EngineConfig(settings, apiBase, null, ProcessorState.KeyUnreadable,
                "The saved agent key cannot be read on this computer. Open DineroBook Manager and sign in again.");
        }
        catch (UnauthorizedAccessException)
        {
            return new EngineConfig(settings, apiBase, null, ProcessorState.KeyUnreadable,
                "The service may not read the saved agent key. Open DineroBook Manager and choose Install / Update to fix the permissions.");
        }
        catch (IOException ex)
        {
            return new EngineConfig(settings, apiBase, null, ProcessorState.KeyUnreadable, "Busy: " + ex.Message);
        }
        if (key is null)
        {
            return new EngineConfig(settings, apiBase, null, ProcessorState.NotSignedIn,
                "Not signed in. Open DineroBook Manager and sign in to connect this computer to its store.");
        }
        return new EngineConfig(settings, apiBase, key, "", settingsProblem);
    }
}
