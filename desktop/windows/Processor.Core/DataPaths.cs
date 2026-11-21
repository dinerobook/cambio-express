namespace DineroBook.Processor;

/// <summary>
/// Where the Processor keeps its files: one folder,
/// <c>%ProgramData%\DineroBook\Processor</c> (or <c>--data-dir</c> when testing).
/// <code>
/// settings.json        what the Manager set: server, Passport folder, store
/// agent-key.bin        the store's agent key, DPAPI (LocalMachine) encrypted
/// state\inbox\         each Passport file, copied the moment it appears;
///                      sent from here and deleted once the server has it
/// state\archive\       sent files kept on this PC (only with "Delete files
///                      from the temp folder" unticked), one folder a day
/// state\collected.txt  files copied from the Passport folder (never copied twice)
/// state\sent.txt       files the server accepted (the ledger)
/// state\skipped.txt    files the server refused for good (422)
/// state\status.json    what the service is doing, for the Manager
/// state\logs\          one log file per day
/// </code>
/// The top folder is the Manager's (administrators write it); <c>state</c> is
/// the service's (it may write there and nowhere else).
/// </summary>
public sealed class DataPaths
{
    public const string ServiceName = "DineroBookProcessor";
    public const string DataDirOption = "--data-dir";

    /// <summary>The service's Event Log source (Application log). DineroBook
    /// Manager registers it at install; registering needs administrator
    /// rights the service does not have.</summary>
    public const string EventSource = "DineroBook Processor";

    public DataPaths(string root, bool isCustom = false)
    {
        Root = Path.GetFullPath(root);
        IsCustom = isCustom;
    }

    public static string DefaultRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "DineroBook", "Processor");

    /// <summary>The default folder, or the one after <c>--data-dir</c>.</summary>
    public static DataPaths FromArgs(IReadOnlyList<string> args)
    {
        for (var i = 0; i < args.Count - 1; i++)
        {
            if (string.Equals(args[i], DataDirOption, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(args[i + 1]))
            {
                return new DataPaths(args[i + 1], isCustom: true);
            }
        }
        return new DataPaths(DefaultRoot);
    }

    public string Root { get; }

    /// <summary>True for a <c>--data-dir</c> folder (testing), false for the
    /// machine's own folder under ProgramData.</summary>
    public bool IsCustom { get; }

    public string Settings => Path.Combine(Root, "settings.json");
    public string AgentKey => Path.Combine(Root, "agent-key.bin");
    public string State => Path.Combine(Root, "state");
    public string Inbox => Path.Combine(State, "inbox");
    /// <summary>Where a copy is written before it is moved into the inbox
    /// whole, so the sender never sees half a file.</summary>
    public string Incoming => Path.Combine(Inbox, ".incoming");
    public string CollectedLedger => Path.Combine(State, "collected.txt");
    public string Archive => Path.Combine(State, "archive");
    public string SentLedger => Path.Combine(State, "sent.txt");
    public string SkippedLedger => Path.Combine(State, "skipped.txt");
    public string Status => Path.Combine(State, "status.json");
    public string Logs => Path.Combine(State, "logs");
}
