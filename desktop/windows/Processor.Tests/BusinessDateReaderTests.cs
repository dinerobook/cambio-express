using System.Text;
using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

/// <summary>The business day a file carries, read the way the server reads
/// it (naxml.py :: parse_pjr; movement.py :: _header).</summary>
public class BusinessDateReaderTests
{
    private static BusinessDay Read(string xml, bool complete = true) => BusinessDateReader.Read(Naxml.Bytes(xml), complete);

    private static BusinessDay Day(int y, int m, int d) => BusinessDay.Of(new DateOnly(y, m, d));

    [Theory]
    [InlineData("SaleEvent")]
    [InlineData("RefundEvent")]
    [InlineData("VoidEvent")]
    [InlineData("OtherEvent")]
    [InlineData("FinancialEvent")]
    public void A_journal_event_names_its_day(string kind)
    {
        Assert.Equal(Day(2026, 11, 17), Read(Naxml.Journal(Naxml.Event(kind, "2026-11-17"))));
    }

    [Fact]
    public void The_server_picks_the_event_kind_by_its_own_order_not_the_files()
    {
        // parse_pjr looks for SaleEvent first, wherever it is.
        var xml = Naxml.Journal(Naxml.Event("OtherEvent", "2026-11-16") + Naxml.Event("SaleEvent", "2026-11-17"));
        Assert.Equal(Day(2026, 11, 17), Read(xml));
        var refundThenVoid = Naxml.Journal(Naxml.Event("VoidEvent", "2026-11-15") + Naxml.Event("RefundEvent", "2026-11-14"));
        Assert.Equal(Day(2026, 11, 14), Read(refundThenVoid));
    }

    [Fact]
    public void The_first_event_of_a_kind_and_its_first_date_count()
    {
        var xml = Naxml.Journal(Naxml.Event("SaleEvent", "2026-11-17") + Naxml.Event("SaleEvent", "2026-11-18"));
        Assert.Equal(Day(2026, 11, 17), Read(xml));
    }

    [Fact]
    public void A_date_outside_the_event_does_not_count()
    {
        var xml = Naxml.Journal(Naxml.Event("SaleEvent", "2026-11-17"), headerExtra: "<BusinessDate>2026-01-01</BusinessDate>");
        Assert.Equal(Day(2026, 11, 17), Read(xml));
        var headerOnly = Naxml.Journal(Naxml.Event("SaleEvent", null), headerExtra: "<BusinessDate>2026-01-01</BusinessDate>");
        Assert.Equal(DayKind.Undated, Read(headerOnly).Kind);
    }

    [Theory]
    [InlineData("<BusinessDate></BusinessDate>")]
    [InlineData("<BusinessDate/>")]
    [InlineData("<BusinessDate>   </BusinessDate>")]
    [InlineData("<BusinessDate>17/11/2026</BusinessDate>")]
    [InlineData("<BusinessDate>yesterday</BusinessDate>")]
    [InlineData("")]
    public void No_readable_date_in_the_event_is_undated(string dateElement)
    {
        var xml = Naxml.Journal($"<SaleEvent><RegisterID>1</RegisterID>{dateElement}</SaleEvent>");
        Assert.Equal(DayKind.Undated, Read(xml).Kind);
    }

    [Fact]
    public void Spaces_around_the_date_are_fine()
    {
        Assert.Equal(Day(2026, 11, 7), Read(Naxml.Journal("<SaleEvent><BusinessDate>\n 2026-11-07 \n</BusinessDate></SaleEvent>")));
    }

    [Fact]
    public void A_journal_with_no_event_is_undated()
    {
        Assert.Equal(DayKind.Undated, Read(Naxml.Journal("<JournalSummary/>")).Kind);
    }

    [Theory]
    [InlineData("FuelGradeMovement")]
    [InlineData("ItemSalesMovement")]
    [InlineData("MerchandiseCodeMovement")]
    [InlineData("MiscellaneousSummaryMovement")]
    [InlineData("TaxLevelMovement")]
    [InlineData("TankProductMovement")]
    public void A_movement_report_names_its_day_in_the_header(string family)
    {
        Assert.Equal(Day(2026, 11, 17), Read(Naxml.Movement(family, "2026-11-17")));
    }

    [Fact]
    public void A_movement_report_without_a_header_date_is_undated()
    {
        Assert.Equal(DayKind.Undated, Read(Naxml.Movement("FuelGradeMovement", null)).Kind);
        var dateOutsideHeader = Naxml.Prolog + "<NAXML-MovementReport><FuelGradeMovement><FGMDetail><BusinessDate>2026-11-17</BusinessDate></FGMDetail></FuelGradeMovement></NAXML-MovementReport>";
        Assert.Equal(DayKind.Undated, Read(dateOutsideHeader).Kind);
    }

    [Theory]
    [InlineData("<html><body>hello</body></html>")]
    [InlineData("not xml at all")]
    [InlineData("")]
    [InlineData("<NAXML-POSJournal><JournalReport><OtherEvent><BusinessDate>2026-11-17</BusinessDate>")]
    [InlineData("<NAXML-POSJournal><JournalReport><SaleEvent><RegisterID>1</RegisterID>")]
    public void A_finished_file_the_server_cannot_read_is_undated(string content)
    {
        Assert.Equal(DayKind.Undated, Read(content).Kind);
    }

    [Fact]
    public void A_broken_file_that_shows_a_sale_date_first_counts_as_dated()
    {
        // Reading stops at a sale's date (nothing outranks it), so a file
        // that breaks later still waits its day's turn. The safe side: the
        // server would store it undated, and nothing is sent early.
        Assert.Equal(Day(2026, 11, 17), Read("<NAXML-POSJournal><JournalReport><SaleEvent><BusinessDate>2026-11-17</BusinessDate>"));
    }

    [Fact]
    public void A_file_still_being_written_gives_the_date_seen_so_far()
    {
        var full = Naxml.Sale("2026-11-17");
        var cut = full[..(full.IndexOf("</BusinessDate>", StringComparison.Ordinal) + "</BusinessDate>".Length)];
        Assert.Equal(Day(2026, 11, 17), Read(cut, complete: false));
        var before = full[..full.IndexOf("<BusinessDate>", StringComparison.Ordinal)];
        Assert.Equal(DayKind.Unknown, Read(before, complete: false).Kind);
        var insideDate = full[..(full.IndexOf("<BusinessDate>", StringComparison.Ordinal) + 18)];
        Assert.Equal(DayKind.Unknown, Read(insideDate, complete: false).Kind);
        Assert.Equal(DayKind.Unknown, Read("", complete: false).Kind);
        Assert.Equal(DayKind.Unknown, Read(Naxml.Movement("FuelGradeMovement", "2026-11-17")[..60], complete: false).Kind);
    }

    [Fact]
    public void A_dtd_is_refused_and_entities_never_expand()
    {
        var laughs = "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY lol \"lol\"><!ENTITY lol2 \"&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;\">]>"
                     + "<NAXML-POSJournal><SaleEvent><BusinessDate>&lol2;</BusinessDate></SaleEvent></NAXML-POSJournal>";
        Assert.Equal(DayKind.Undated, Read(laughs).Kind);
        var external = "<?xml version=\"1.0\"?><!DOCTYPE x SYSTEM \"http://example.invalid/x.dtd\"><NAXML-POSJournal><SaleEvent><BusinessDate>2026-11-17</BusinessDate></SaleEvent></NAXML-POSJournal>";
        Assert.Equal(DayKind.Undated, Read(external).Kind);
    }

    [Fact]
    public void Names_count_whatever_their_namespace()
    {
        // The server would not find a namespaced event (no date there); a
        // date here only makes the file wait its turn, which is safe.
        var xml = "<n:NAXML-POSJournal xmlns:n=\"http://www.naxml.org/POSBO/Vocabulary/2003-10-16\"><n:JournalReport><n:SaleEvent><n:BusinessDate>2026-11-17</n:BusinessDate></n:SaleEvent></n:JournalReport></n:NAXML-POSJournal>";
        Assert.Equal(Day(2026, 11, 17), Read(xml));
    }

    [Fact]
    public void Latin1_and_windows_1252_files_read()
    {
        var latin = Naxml.Journal("<SaleEvent><Description>Café</Description><BusinessDate>2026-11-17</BusinessDate></SaleEvent>");
        Assert.Equal(Day(2026, 11, 17), BusinessDateReader.Read(Encoding.Latin1.GetBytes(latin), complete: true));
        var cp1252 = latin.Replace("ISO-8859-1", "windows-1252").Replace("Café", "€5");
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        Assert.Equal(Day(2026, 11, 17), BusinessDateReader.Read(Encoding.GetEncoding(1252).GetBytes(cp1252), complete: true));
    }

    [Fact]
    public void Another_document_is_undated()
    {
        Assert.Equal(DayKind.Undated, Read("<Invoice><BusinessDate>2026-11-17</BusinessDate></Invoice>").Kind);
    }

    [Fact]
    public void A_huge_document_stops_at_the_cap()
    {
        var huge = Naxml.Journal("<OtherEvent><Pad>" + new string('a', (int)BusinessDateReader.MaxCharacters + 10) + "</Pad><BusinessDate>2026-11-17</BusinessDate></OtherEvent>");
        Assert.Equal(DayKind.Undated, Read(huge).Kind);
    }
}
