using System.Runtime.InteropServices;
using System.Text;

namespace DineroBook.CheckDesk;

/// <summary>
/// The MagTek Excella through MagTek's MTXMLMCR.dll (installed with the
/// scanner's USB driver, the same library the store's current check
/// program uses). Excella &amp; Excella STX Windows API, MagTek
/// 99875340: open the first device, build ProcessOptions and
/// ImageOptions, MTMICRProcessCheck waits for the check, then read the
/// DocInfo MICR keys and fetch the two pictures by their ImageURL.
/// Only one program can hold the scanner: close the old check program
/// first.
/// </summary>
internal sealed class ExcellaScanner : IScanner, IDisposable
{
    private const string Dll = "MTXMLMCR.dll";
    private const uint Ok = 0; // MICR_ST_OK

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRGetDevice(uint context, StringBuilder name);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICROpenDevice(string name);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRCloseDevice(string name);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRSetValue(
        StringBuilder options, string section, string key, string value, ref uint length);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRSetIndexValue(
        StringBuilder options, string section, string key, uint index, string value, ref uint length);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRProcessCheck(
        string name, string options, StringBuilder docInfo, ref uint docInfoSize);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRGetValue(
        string docInfo, string section, string key, StringBuilder value, ref uint length);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRGetIndexValue(
        string docInfo, string section, string key, uint index, StringBuilder value, ref uint length);

    [DllImport(Dll, CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern uint MTMICRGetImage(string name, string imageId, byte[] buffer, ref uint length);

    private const int OptionsSize = 8192;
    private const int DocInfoSize = 65536;

    private readonly string _docFeed;
    private readonly object _lock = new();
    private string? _device;

    public ExcellaScanner(string docFeed)
    {
        _docFeed = docFeed;
    }

    public Task<bool> IsReadyAsync() => Task.Run(() =>
    {
        lock (_lock)
        {
            try
            {
                return Open() is not null;
            }
            catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
            {
                return false;
            }
        }
    });

    public Task<ScanResult> ScanAsync(CancellationToken cancel) => Task.Run(() =>
    {
        lock (_lock)
        {
            string device;
            try
            {
                device = Open() ?? throw new ScannerException(ScanErrors.NotConnected);
            }
            catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
            {
                throw new ScannerException(ScanErrors.NotConnected, e.Message);
            }
            cancel.ThrowIfCancellationRequested();

            var options = new StringBuilder(OptionsSize);
            Set(options, "ProcessOptions", "DocFeed", _docFeed);
            Set(options, "ProcessOptions", "ReadMICR", "E13B");
            Set(options, "ImageOptions", "Number", "2");
            for (uint side = 1; side <= 2; side++)
            {
                SetIndex(options, "ImageOptions", "ImageColor", side, "GRAY8");
                SetIndex(options, "ImageOptions", "Resolution", side, "200X200");
                SetIndex(options, "ImageOptions", "Compression", side, "JPEG");
                SetIndex(options, "ImageOptions", "FileType", side, "JPG");
                SetIndex(options, "ImageOptions", "ImageSide", side, side == 1 ? "FRONT" : "BACK");
            }

            var doc = new StringBuilder(DocInfoSize);
            uint docSize = DocInfoSize;
            var status = MTMICRProcessCheck(device, options.ToString(), doc, ref docSize);
            if (status != Ok)
            {
                // A lost connection needs the device opened again.
                Close();
                throw new ScannerException(ScanErrors.Failed, $"MTMICRProcessCheck returned {status}");
            }
            var info = doc.ToString();

            var raw = Get(info, "DocInfo", "MICRRaw");
            var decode = Get(info, "DocInfo", "MICRDecode");
            if (raw.Trim() == "" && decode.Equals("NONE", StringComparison.OrdinalIgnoreCase))
            {
                throw new ScannerException(ScanErrors.Failed, "No MICR line on the check (upside down?)");
            }
            var amount = Digits(Get(info, "DocInfo", "MICRAmt"));
            return new ScanResult(
                raw.Trim(),
                Digits(Get(info, "DocInfo", "MICRTransit")),
                Digits(Get(info, "DocInfo", "MICRAcct")),
                Digits(Get(info, "DocInfo", "MICRSerNum")).TrimStart('0'),
                amount == "" ? null : long.Parse(amount),
                Image(device, info, 1),
                Image(device, info, 2));
        }
    });

    private string? Open()
    {
        if (_device is not null) return _device;
        var name = new StringBuilder(128);
        if (MTMICRGetDevice(1, name) != Ok || name.Length == 0) return null;
        if (MTMICROpenDevice(name.ToString()) != Ok) return null;
        _device = name.ToString();
        return _device;
    }

    private void Close()
    {
        if (_device is null) return;
        try
        {
            MTMICRCloseDevice(_device);
        }
        catch (Exception)
        {
            // Closing a device that is already gone changes nothing.
        }
        _device = null;
    }

    private static void Set(StringBuilder options, string section, string key, string value)
    {
        uint length = OptionsSize;
        MTMICRSetValue(options, section, key, value, ref length);
    }

    private static void SetIndex(StringBuilder options, string section, string key, uint index, string value)
    {
        uint length = OptionsSize;
        MTMICRSetIndexValue(options, section, key, index, value, ref length);
    }

    private static string Get(string info, string section, string key)
    {
        var value = new StringBuilder(1024);
        uint length = 1024;
        return MTMICRGetValue(info, section, key, value, ref length) == Ok ? value.ToString() : "";
    }

    private static byte[]? Image(string device, string info, uint index)
    {
        var url = new StringBuilder(1024);
        uint urlLength = 1024;
        if (MTMICRGetIndexValue(info, "ImageInfo", "ImageURL", index, url, ref urlLength) != Ok) return null;
        var size = new StringBuilder(32);
        uint sizeLength = 32;
        if (MTMICRGetIndexValue(info, "ImageInfo", "ImageSize", index, size, ref sizeLength) != Ok) return null;
        if (!uint.TryParse(size.ToString(), out var bytes) || bytes == 0 || bytes > 20_000_000) return null;
        var buffer = new byte[bytes];
        var length = bytes;
        if (MTMICRGetImage(device, url.ToString(), buffer, ref length) != Ok) return null;
        return length == bytes ? buffer : buffer[..(int)Math.Min(length, bytes)];
    }

    private static string Digits(string text) => new(text.Where(char.IsAsciiDigit).ToArray());

    public void Dispose()
    {
        lock (_lock) Close();
    }
}
