using System.Globalization;
using System.Text;
using System.Xml;

namespace DineroBook.Processor;

/// <summary>What a file says about its business day.</summary>
public enum DayKind
{
    /// <summary>It names its business day.</summary>
    Dated,

    /// <summary>It never will (not a journal or movement report, no
    /// BusinessDate, a broken document): sent with no day barrier.</summary>
    Undated,

    /// <summary>Not known yet: the file is still being written, or could
    /// not be opened just now.</summary>
    Unknown,
}

public readonly record struct BusinessDay(DayKind Kind, DateOnly Date)
{
    public static BusinessDay Undated => new(DayKind.Undated, default);
    public static BusinessDay Unknown => new(DayKind.Unknown, default);
    public static BusinessDay Of(DateOnly date) => new(DayKind.Dated, date);

    public override string ToString() => Kind == DayKind.Dated
        ? Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
        : Kind.ToString().ToLowerInvariant();
}

/// <summary>
/// Reads a Passport file's business day the way the server will, so the
/// Processor can keep a day's files ahead of the next day's (the server
/// books day D as soon as a file of a later day arrives).
/// <list type="bullet">
/// <item>Journal (<c>NAXML-POSJournal</c>): the first event found in the
/// server's order (SaleEvent, RefundEvent, VoidEvent, OtherEvent,
/// FinancialEvent), then the first <c>BusinessDate</c> inside it
/// (api/Modules/PosImport/Services/naxml.py :: parse_pjr).</item>
/// <item>Movement report (<c>NAXML-MovementReport</c>): the family's
/// <c>MovementHeader/BusinessDate</c> (movement.py :: _header).</item>
/// </list>
/// Where it differs from the server it errs towards "dated" (names are
/// matched without their namespace; a family the server does not know
/// still counts): a dated file only waits for older days, while an
/// undated one is sent with no barrier. Read with XmlReader: DTDs
/// prohibited, no resolver, a size cap. Nothing in the file is trusted
/// beyond the date.
/// </summary>
public static class BusinessDateReader
{
    /// <summary>Characters read at most (the server takes 4 MB files).</summary>
    public const long MaxCharacters = 8L * 1024 * 1024;

    private static readonly string[] EventKinds = ["SaleEvent", "RefundEvent", "VoidEvent", "OtherEvent", "FinancialEvent"];
    private static readonly string[] DateFormats = ["yyyy-MM-dd", "yyyy-M-d"];

    static BusinessDateReader()
    {
        // A file declaring windows-1252 (or another code page) must still read.
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    private static XmlReaderSettings Settings() => new()
    {
        DtdProcessing = DtdProcessing.Prohibit,
        XmlResolver = null,
        MaxCharactersInDocument = MaxCharacters,
        MaxCharactersFromEntities = 1024,
        IgnoreComments = true,
        IgnoreProcessingInstructions = true,
        IgnoreWhitespace = true,
        CloseInput = false,
    };

    public static BusinessDay Read(byte[] content, bool complete)
    {
        using var ms = new MemoryStream(content, writable: false);
        return Read(ms, complete);
    }

    /// <summary>
    /// <paramref name="complete"/>: the file is final (it held still, or these
    /// are the bytes about to be sent). The whole document is read and the
    /// answer is the server's. Not complete: the file may still be growing; a
    /// document that ends early gives the date seen so far, else Unknown.
    /// </summary>
    public static BusinessDay Read(Stream content, bool complete)
    {
        var mode = Mode.None;
        var depth = 0;
        // Journal: per event kind, whether its first element was seen and the
        // date inside it ("" = none found).
        var seen = new Dictionary<string, string?>(StringComparer.Ordinal);
        string? openEvent = null;
        var openEventDepth = -1;
        var inBusinessDate = false;
        var text = new StringBuilder();
        // Movement report: root > family > MovementHeader > BusinessDate.
        var familyDepth = -1;
        var familySeen = false;
        var inHeader = false;

        try
        {
            using var reader = XmlReader.Create(content, Settings());
            while (reader.Read())
            {
                switch (reader.NodeType)
                {
                    case XmlNodeType.Element:
                    {
                        var name = reader.LocalName;
                        var empty = reader.IsEmptyElement;
                        if (depth == 0)
                        {
                            mode = name.Contains("POSJournal", StringComparison.Ordinal) ? Mode.Journal
                                : name.Contains("MovementReport", StringComparison.Ordinal) ? Mode.Movement
                                : Mode.Other;
                            if (mode == Mode.Other) return BusinessDay.Undated;
                        }
                        else if (mode == Mode.Journal)
                        {
                            if (openEvent is null && Array.IndexOf(EventKinds, name) >= 0 && !seen.ContainsKey(name))
                            {
                                seen[name] = null;
                                if (!empty)
                                {
                                    openEvent = name;
                                    openEventDepth = depth;
                                }
                                else
                                {
                                    seen[name] = "";
                                }
                            }
                            else if (openEvent is not null && seen[openEvent] is null && name == "BusinessDate")
                            {
                                if (empty) seen[openEvent] = "";
                                else
                                {
                                    inBusinessDate = true;
                                    text.Clear();
                                }
                            }
                        }
                        else if (mode == Mode.Movement)
                        {
                            if (depth == 1 && !familySeen && name != "TransmissionHeader")
                            {
                                familySeen = true;
                                familyDepth = depth;
                                if (empty) return BusinessDay.Undated;
                            }
                            else if (depth == familyDepth + 1 && familyDepth >= 0 && name == "MovementHeader")
                            {
                                inHeader = !empty;
                            }
                            else if (inHeader && depth == familyDepth + 2 && name == "BusinessDate")
                            {
                                if (empty) return BusinessDay.Undated;
                                inBusinessDate = true;
                                text.Clear();
                            }
                        }
                        if (!empty) depth++;
                        break;
                    }
                    case XmlNodeType.Text:
                    case XmlNodeType.CDATA:
                    case XmlNodeType.SignificantWhitespace:
                        if (inBusinessDate) text.Append(reader.Value);
                        break;
                    case XmlNodeType.EndElement:
                    {
                        depth--;
                        var name = reader.LocalName;
                        if (inBusinessDate && name == "BusinessDate")
                        {
                            inBusinessDate = false;
                            if (mode == Mode.Movement) return Parse(text.ToString());
                            seen[openEvent!] = text.ToString();
                            // Nothing outranks a sale: no need to read on.
                            if (openEvent == EventKinds[0]) return Decide(seen);
                        }
                        else if (mode == Mode.Journal && openEvent is not null && depth == openEventDepth && name == openEvent)
                        {
                            seen[openEvent] ??= "";
                            openEvent = null;
                            openEventDepth = -1;
                        }
                        else if (mode == Mode.Movement)
                        {
                            if (inHeader && depth == familyDepth + 1 && name == "MovementHeader") inHeader = false;
                            if (familyDepth >= 0 && depth == familyDepth && familySeen)
                            {
                                // The family ended without a header date.
                                return BusinessDay.Undated;
                            }
                        }
                        break;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is XmlException or DecoderFallbackException or ArgumentException or IOException)
        {
            // Ended early, or not XML. A finished file the server cannot
            // parse gets no business day there either.
            if (complete) return BusinessDay.Undated;
            if (mode == Mode.Journal && openEvent is not null && inBusinessDate) return BusinessDay.Unknown;
            var soFar = mode == Mode.Journal ? Decide(seen, partial: true) : BusinessDay.Unknown;
            return soFar.Kind == DayKind.Dated ? soFar : BusinessDay.Unknown;
        }

        return mode switch
        {
            Mode.Journal => Decide(seen),
            Mode.None => complete ? BusinessDay.Undated : BusinessDay.Unknown,
            _ => BusinessDay.Undated,
        };
    }

    /// <summary>The server's choice: the first event kind present, in its
    /// order, and that event's date.</summary>
    private static BusinessDay Decide(Dictionary<string, string?> seen, bool partial = false)
    {
        foreach (var kind in EventKinds)
        {
            if (!seen.TryGetValue(kind, out var raw)) continue;
            if (raw is null) return partial ? BusinessDay.Unknown : BusinessDay.Undated;
            return Parse(raw);
        }
        return BusinessDay.Undated;
    }

    private static BusinessDay Parse(string raw)
    {
        var t = raw.Trim();
        return DateOnly.TryParseExact(t, DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)
            ? BusinessDay.Of(d)
            : BusinessDay.Undated;
    }

    private enum Mode { None, Journal, Movement, Other }
}
