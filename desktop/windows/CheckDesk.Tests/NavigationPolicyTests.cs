using DineroBook.CheckDesk;
using Xunit;

namespace CheckDesk.Tests;

// The window shows DineroBook only; only its pages reach the scanner.
public class NavigationPolicyTests
{
    private static readonly Uri Home = new("https://dinerobook.com/app/check-cashing");

    [Theory]
    [InlineData("https://dinerobook.com/app/check-cashing/customers", true)]
    [InlineData("https://DINEROBOOK.com/app/login", true)]
    [InlineData("http://dinerobook.com/app", false)]
    [InlineData("https://dinerobook.com.evil.example/app", false)]
    [InlineData("https://evil.example/?https://dinerobook.com", false)]
    [InlineData("https://dinerobook.com:8443/app", false)]
    [InlineData("file:///C:/Windows/system32/calc.exe", false)]
    [InlineData("not a url", false)]
    [InlineData(null, false)]
    public void Own_page(string? address, bool own)
    {
        Assert.Equal(own, NavigationPolicy.IsOwnPage(address, Home));
    }

    [Theory]
    [InlineData("https://stripe.com/docs", true)]
    [InlineData("mailto:help@example.com", true)]
    [InlineData("file:///C:/Windows/system32/calc.exe", false)]
    [InlineData("ms-settings:privacy", false)]
    [InlineData("javascript:alert(1)", false)]
    public void Open_outside(string address, bool may)
    {
        Assert.Equal(may, NavigationPolicy.MayOpenOutside(address));
    }
}
