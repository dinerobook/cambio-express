using System.Text;

namespace DineroBook.Processor;

/// <summary>Small file helpers shared by the service and the Manager.</summary>
public static class AtomicFile
{
    /// <summary>Writes the whole file or nothing: a reader never sees half a
    /// file. The new copy is written next to the old one, then renamed over
    /// it, so it takes the folder's inherited permissions.</summary>
    public static void WriteAllText(string path, string text)
    {
        var temp = path + ".new";
        File.WriteAllText(temp, text, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>Reads a file another process may be writing or replacing
    /// at the same moment, without getting in its way. Null when it is not
    /// there.</summary>
    public static string? TryReadShared(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs, Encoding.UTF8);
            return reader.ReadToEnd();
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }
}
