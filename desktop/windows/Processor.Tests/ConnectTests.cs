using System.Text.Json;
using DineroBook.Processor;
using DineroBook.Processor.Connect;
using Xunit;

namespace Processor.Tests;

/// <summary>"Connect" with a one-time code, in the server's shapes
/// (api/Modules/PosImport/Requests :: AgentPairRequest / AgentPairResponse
/// and the HTTPException details of agent_pair_route). Nobody types a name
/// or a password (owner, 2026-11-19).</summary>
public class ConnectTests
{
    private const string NewKey = "pak_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
    private const string OldKey = "pak_OLD_0123456789abcdefghijklmnopqrstuvwxyzAB";
    private static readonly Uri Api = new("https://dinerobook.com");

    private const string Paired = """
        {"id":41,"label":"BOPC – DineroBook Processor","key":"pak_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
         "store_id":7,"store_name":"Main St","connected_by":"maria"}
        """;

    private sealed class Sink : IKeySink
    {
        public (IssuedKey Key, ConnectedStore Store)? Saved;
        public Exception? Error;

        public void Save(IssuedKey key, ConnectedStore store)
        {
            if (Error is not null) throw Error;
            Saved = (key, store);
        }
    }

    private static (ConnectClient Client, FakeHandler Handler) Make(int status, string body, RateWindow? guard = null)
    {
        var handler = new FakeHandler((_, _) => FakeHandler.Json(status, body));
        var http = Http.Create("dinerobook-manager/test", TimeSpan.FromSeconds(5), handler);
        return (new ConnectClient(http, Api, guard ?? new RateWindow(8, TimeSpan.FromMinutes(1))), handler);
    }

    [Theory]
    [InlineData("K7M4-Q2XP-9HD3", "K7M4Q2XP9HD3")]
    [InlineData("k7m4 q2xp 9hd3", "K7M4Q2XP9HD3")]
    [InlineData(" K7M4Q2XP9HD3\r\n", "K7M4Q2XP9HD3")]
    public void A_code_reads_the_way_the_server_reads_it(string typed, string sent)
    {
        Assert.Equal(sent, ConnectCode.Normalize(typed));
        Assert.True(ConnectCode.IsComplete(typed));
    }

    [Fact]
    public async Task A_good_code_saves_the_key_and_names_the_store()
    {
        var (client, handler) = Make(200, Paired);
        var sink = new Sink();
        var r = await client.ConnectAsync("k7m4-q2xp-9hd3", "BOPC – DineroBook Processor", null, sink, CancellationToken.None);
        Assert.True(r.Ok, r.Message);
        Assert.Contains("Main St", r.Message);
        Assert.Equal(NewKey, sink.Saved!.Value.Key.Key);
        Assert.Equal(new ConnectedStore(7, "Main St", "maria"), sink.Saved.Value.Store);

        var (request, body) = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://dinerobook.com" + ServerContract.PairPath, request.RequestUri!.ToString());
        using var doc = JsonDocument.Parse(body);
        Assert.Equal("K7M4Q2XP9HD3", doc.RootElement.GetProperty("code").GetString());
        Assert.Equal("BOPC – DineroBook Processor", doc.RootElement.GetProperty("label").GetString());
        // No sign-in of any kind travels with it.
        Assert.False(request.Headers.Contains("Authorization"));
        Assert.False(request.Headers.Contains(ServerContract.AgentKeyHeader));
    }

    [Fact]
    public async Task The_previous_key_rides_along_so_the_server_revokes_it()
    {
        var (client, handler) = Make(200, Paired);
        await client.ConnectAsync("K7M4Q2XP9HD3", "x", OldKey, new Sink(), CancellationToken.None);
        var request = Assert.Single(handler.Requests).Request;
        Assert.Equal(OldKey, Assert.Single(request.Headers.GetValues(ServerContract.AgentKeyHeader)));
    }

    [Fact]
    public async Task An_unfinished_code_is_not_sent()
    {
        var (client, handler) = Make(200, Paired);
        var r = await client.ConnectAsync("K7M4-Q2", "x", null, new Sink(), CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Contains("12 letters and numbers", r.Message);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task A_refused_code_shows_the_servers_sentence()
    {
        var detail = "This connect code does not work: it was mistyped, already used, or is older than 10 minutes. Make a new one in DineroBook: Register import → Automatic uploads.";
        var (client, _) = Make(401, JsonSerializer.Serialize(new { detail }));
        var sink = new Sink();
        var r = await client.ConnectAsync("K7M4Q2XP9HD3", "x", null, sink, CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Equal(detail, r.Message);
        Assert.Null(sink.Saved);
    }

    [Theory]
    [InlineData(403, """{"detail":"This store has been disabled. Contact support.","reason":"store_disabled"}""", "This store has been disabled")]
    [InlineData(402, """{"detail":"This store's subscription has lapsed.","reason":"subscription"}""", "lapsed")]
    [InlineData(429, """{"detail":"Rate limit exceeded"}""", "Wait a minute")]
    [InlineData(422, """{"detail":[{"msg":"Field required"}]}""", "needs an update")]
    [InlineData(500, "oops", "HTTP 500")]
    [InlineData(200, """{"id":1}""", "Unexpected answer")]
    public async Task Other_answers_are_said_in_words(int status, string body, string expected)
    {
        var (client, _) = Make(status, body);
        var r = await client.ConnectAsync("K7M4Q2XP9HD3", "x", null, new Sink(), CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Contains(expected, r.Message);
    }

    [Fact]
    public async Task A_key_that_cannot_be_saved_says_what_to_do()
    {
        var (client, _) = Make(200, Paired);
        var r = await client.ConnectAsync("K7M4Q2XP9HD3", "x", null, new Sink { Error = new UnauthorizedAccessException("denied") }, CancellationToken.None);
        Assert.False(r.Ok);
        Assert.Contains("denied", r.Message);
        Assert.Contains("Revoke it in DineroBook", r.Message);
    }

    [Fact]
    public async Task Too_many_tries_wait_without_calling_the_server()
    {
        var guard = new RateWindow(2, TimeSpan.FromMinutes(1));
        var (client, handler) = Make(401, """{"detail":"no"}""", guard);
        for (var i = 0; i < 2; i++) await client.ConnectAsync("K7M4Q2XP9HD3", "x", null, new Sink(), CancellationToken.None);
        var r = await client.ConnectAsync("K7M4Q2XP9HD3", "x", null, new Sink(), CancellationToken.None);
        Assert.Contains("Too many tries", r.Message);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public void The_key_label_fits_the_server()
    {
        Assert.Equal("BOPC – DineroBook Processor", ConnectClient.KeyLabel("BOPC"));
        Assert.Equal(ServerContract.MaxKeyLabelLength, ConnectClient.KeyLabel(new string('X', 200)).Length);
    }

    [Fact]
    public void The_issued_key_never_prints()
    {
        Assert.DoesNotContain("pak_", new IssuedKey(1, "x", NewKey).ToString());
    }
}
