using System.Globalization;

namespace DineroBook.Processor;

/// <summary>
/// What happens to a file's copy in this computer's temp folder
/// (<see cref="DataPaths.Inbox"/>) once DineroBook has it, or refused it
/// for good: "Delete files from the temp folder" in DineroBook Manager
/// (<see cref="ProcessorSettings.DeleteFromInbox"/>).
/// <list type="bullet">
/// <item>Ticked (the default): the copy is deleted.</item>
/// <item>Unticked: the copy is moved to <see cref="DataPaths.Archive"/>, one
/// folder per local day (<c>state\archive\2026-11-20\</c>), and kept on this
/// computer. Moved, not left in the inbox, so the inbox only ever holds
/// files still to send and its listing stays quick.</item>
/// </list>
/// The sent ledger, not this copy, is what keeps a file from going twice.
/// </summary>
public static class InboxFiles
{
    public static void Finish(DataPaths paths, string name, bool delete, DateTimeOffset at, TimeZoneInfo zone)
    {
        var copy = Path.Combine(paths.Inbox, name);
        if (!File.Exists(copy)) return;
        if (delete)
        {
            File.Delete(copy);
            return;
        }
        var day = TimeZoneInfo.ConvertTime(at, zone).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var folder = Path.Combine(paths.Archive, day);
        Directory.CreateDirectory(folder);
        File.Move(copy, Path.Combine(folder, name), overwrite: true);
    }
}
