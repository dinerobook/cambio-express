using DineroBook.CheckDesk;
using Xunit;

namespace CheckDesk.Tests;

public class AppSettingsTests
{
    [Fact]
    public void Defaults_open_check_cashing_with_a_manual_feed()
    {
        var s = AppSettings.Load(null);
        Assert.Equal("https://dinerobook.com/app/check-cashing", s.Home);
        Assert.Equal("MANUAL", s.DocFeed);
        Assert.False(s.DemoScanner);
    }

    [Fact]
    public void Reads_the_file()
    {
        var s = AppSettings.Load("""{"home":"http://localhost:5055/app/check-cashing","docFeed":"autofeed","demoScanner":true}""");
        Assert.Equal("http://localhost:5055/app/check-cashing", s.Home);
        Assert.Equal("AUTOFEED", s.DocFeed);
        Assert.True(s.DemoScanner);
    }

    [Theory]
    [InlineData("""{"home":"http://evil.example/app"}""")]
    [InlineData("""{"home":"file:///C:/page.html"}""")]
    [InlineData("""{"home":"nonsense"}""")]
    [InlineData("not json")]
    public void Refuses_a_home_that_is_not_https(string json)
    {
        Assert.Equal(AppSettings.DefaultHome, AppSettings.Load(json).Home);
    }

    [Fact]
    public void An_unknown_feed_is_manual()
    {
        Assert.Equal("MANUAL", AppSettings.Load("""{"docFeed":"sideways"}""").DocFeed);
    }
}
