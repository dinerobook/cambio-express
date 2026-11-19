using System.Net;
using System.Text.Json;
using DineroBook.Processor;
using Xunit;

namespace Processor.Tests;

public class UploadAnswersTests
{
    [Fact]
    public void Staged()
    {
        var r = UploadAnswers.FromResponse(200, """{"staged":true,"duplicate":false,"business_date":"2026-11-17","parse_error":""}""");
        Assert.Equal(UploadVerdict.Accepted, r.Verdict);
        Assert.Equal("staged", r.Accepted!.Outcome);
        Assert.Equal("2026-11-17", r.Accepted.BusinessDate);
    }

    [Fact]
    public void Duplicate()
    {
        var r = UploadAnswers.FromResponse(200, """{"staged":false,"duplicate":true,"business_date":"2026-11-17","parse_error":""}""");
        Assert.Equal(UploadVerdict.Accepted, r.Verdict);
        Assert.Equal("duplicate", r.Accepted!.Outcome);
    }

    [Fact]
    public void Staged_with_a_parse_error()
    {
        var r = UploadAnswers.FromResponse(200, """{"staged":true,"duplicate":false,"business_date":null,"parse_error":"not NAXML"}""");
        Assert.Equal(UploadVerdict.Accepted, r.Verdict);
        Assert.Equal("parse_error", r.Accepted!.Outcome);
        Assert.Null(r.Accepted.BusinessDate);
        Assert.Equal("not NAXML", r.Accepted.ParseError);
    }

    [Theory]
    [InlineData("<html>Welcome to the hotel wifi</html>")]
    [InlineData("")]
    [InlineData("""{"ok":true}""")]
    [InlineData("""{"staged":"yes","duplicate":false}""")]
    public void A_200_that_is_not_the_upload_answer_is_tried_again(string body)
    {
        Assert.Equal(UploadVerdict.TryAgain, UploadAnswers.FromResponse(200, body).Verdict);
    }

    [Fact]
    public void Key_refused()
    {
        Assert.Equal(UploadVerdict.KeyRejected, UploadAnswers.FromResponse(401, """{"detail":"Invalid agent key."}""").Verdict);
    }

    [Theory]
    [InlineData(402, """{"detail":"This store's subscription has lapsed.","reason":"subscription"}""", "This store's subscription has lapsed.")]
    [InlineData(403, """{"detail":"This store has been disabled. Contact support.","reason":"store_disabled"}""", "This store has been disabled. Contact support.")]
    [InlineData(403, "<html>blocked</html>", "The server refused uploads (HTTP 403).")]
    public void Store_closed(int status, string body, string detail)
    {
        var r = UploadAnswers.FromResponse(status, body);
        Assert.Equal(UploadVerdict.StoreClosed, r.Verdict);
        Assert.Equal(detail, r.Detail);
    }

    [Fact]
    public void A_422_with_a_sentence_is_refused_for_good()
    {
        var r = UploadAnswers.FromResponse(422, """{"detail":"File too large."}""");
        Assert.Equal(UploadVerdict.RejectedForGood, r.Verdict);
        Assert.Equal("File too large.", r.Detail);
    }

    [Fact]
    public void A_422_from_the_request_check_never_skips_files()
    {
        var body = """{"detail":[{"type":"missing","loc":["body","site_id"],"msg":"Field required","input":{}}]}""";
        var r = UploadAnswers.FromResponse(422, body);
        Assert.Equal(UploadVerdict.ContractMismatch, r.Verdict);
        Assert.Contains("body.site_id: Field required", r.Detail);
    }

    [Fact]
    public void A_422_that_is_not_json_never_skips_files()
    {
        Assert.Equal(UploadVerdict.ContractMismatch, UploadAnswers.FromResponse(422, "<html/>").Verdict);
    }

    [Fact]
    public void Rate_limited()
    {
        Assert.Equal(UploadVerdict.RateLimited,
            UploadAnswers.FromResponse(429, """{"detail":"Too many requests — try again in a moment.","limit":"120 per 1 minute"}""").Verdict);
    }

    [Theory]
    [InlineData(500)]
    [InlineData(502)]
    [InlineData(503)]
    [InlineData(504)]
    [InlineData(400)]
    [InlineData(404)]
    [InlineData(405)]
    [InlineData(413)]
    public void Everything_else_is_tried_again(int status)
    {
        Assert.Equal(UploadVerdict.TryAgain, UploadAnswers.FromResponse(status, "oops").Verdict);
    }

    [Fact]
    public void A_network_error_is_tried_again()
    {
        var r = UploadAnswers.FromException(new HttpRequestException("No such host is known."));
        Assert.Equal(UploadVerdict.TryAgain, r.Verdict);
        Assert.Null(r.Status);
    }
}

public class RetryPolicyTests
{
    [Fact]
    public void Backs_off_like_the_python_agent_then_every_five_minutes()
    {
        Assert.Equal(TimeSpan.FromSeconds(5), RetryPolicy.AfterFailures(1));
        Assert.Equal(TimeSpan.FromSeconds(15), RetryPolicy.AfterFailures(2));
        Assert.Equal(TimeSpan.FromMinutes(1), RetryPolicy.AfterFailures(3));
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.AfterFailures(4));
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.AfterFailures(400));
        Assert.Equal(TimeSpan.Zero, RetryPolicy.AfterFailures(0));
    }

    [Fact]
    public void Blocked_and_rate_limited_pauses()
    {
        Assert.Equal(TimeSpan.FromMinutes(5), RetryPolicy.BlockedPause);
        Assert.Equal(TimeSpan.FromMinutes(1), RetryPolicy.RateLimitedPause);
    }
}

public class UploadPacerTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 18, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Spaces_uploads_evenly()
    {
        var p = new UploadPacer();
        Assert.Equal(TimeSpan.Zero, p.WaitBeforeNext(T0));
        p.Record(T0);
        Assert.Equal(UploadPacer.Spacing, p.WaitBeforeNext(T0));
        Assert.Equal(TimeSpan.Zero, p.WaitBeforeNext(T0 + UploadPacer.Spacing));
    }

    [Fact]
    public void Paced_flat_out_it_stays_under_the_servers_limits()
    {
        var p = new UploadPacer();
        var now = T0;
        var sent = new List<DateTimeOffset>();
        // Two hours of a backlog with an instant server.
        while (now < T0.AddHours(2))
        {
            now += p.WaitBeforeNext(now);
            p.Record(now);
            sent.Add(now);
        }
        for (var i = 0; i < sent.Count; i++)
        {
            var inMinute = sent.Skip(i).TakeWhile(t => t < sent[i].AddMinutes(1)).Count();
            Assert.True(inMinute <= UploadPacer.PerMinute, $"{inMinute} in a minute");
            Assert.True(inMinute < ServerContract.UploadLimitPerMinute);
        }
        for (var i = 0; i < sent.Count; i += 97)
        {
            var inHour = sent.Skip(i).TakeWhile(t => t < sent[i].AddHours(1)).Count();
            Assert.True(inHour <= UploadPacer.PerHour, $"{inHour} in an hour");
            Assert.True(inHour < ServerContract.UploadLimitPerHour);
        }
        // ...and still moves a backlog at ~5,000 an hour.
        Assert.InRange(sent.Count, 9_900, 10_001);
    }

    [Fact]
    public void A_rate_window_waits_for_the_oldest_to_leave()
    {
        var w = new RateWindow(3, TimeSpan.FromMinutes(1));
        w.Record(T0);
        w.Record(T0.AddSeconds(10));
        w.Record(T0.AddSeconds(20));
        Assert.Equal(TimeSpan.FromSeconds(30), w.WaitBeforeNext(T0.AddSeconds(30)));
        Assert.Equal(TimeSpan.Zero, w.WaitBeforeNext(T0.AddSeconds(60)));
        Assert.Equal(2, w.CountIn(T0.AddSeconds(60)));
    }
}

public class AgentUploaderTests
{
    private static readonly Uri Api = new("https://dinerobook.com");

    [Fact]
    public async Task Sends_exactly_the_servers_upload_request()
    {
        var handler = new FakeHandler((_, _) => FakeHandler.Json(200, """{"staged":true,"duplicate":false,"business_date":"2026-11-17","parse_error":""}"""));
        using var http = Http.Create("dinerobook-processor/0.1.0", TimeSpan.FromSeconds(30), handler);
        var up = new AgentUploader(http, Api, "pak_TESTKEY_0123456789abcdef");
        var content = "<NAXML-POSJournal/>é"u8.ToArray();

        var r = await up.UploadAsync("PJR1.xml", content, CancellationToken.None);

        Assert.Equal(UploadVerdict.Accepted, r.Verdict);
        var (req, body) = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal("https://dinerobook.com/api/v2/posimport/agent/upload", req.RequestUri!.ToString());
        Assert.Equal("pak_TESTKEY_0123456789abcdef", req.Headers.GetValues("X-Agent-Key").Single());
        Assert.Equal("dinerobook-processor/0.1.0", req.Headers.UserAgent.ToString());
        Assert.Equal("application/json", req.Content!.Headers.ContentType!.MediaType);
        using var doc = JsonDocument.Parse(body);
        // AgentUploadRequest forbids extra fields: exactly these two.
        Assert.Equal(["filename", "content_base64"], doc.RootElement.EnumerateObject().Select(p => p.Name));
        Assert.Equal("PJR1.xml", doc.RootElement.GetProperty("filename").GetString());
        Assert.Equal(content, Convert.FromBase64String(doc.RootElement.GetProperty("content_base64").GetString()!));
    }

    [Fact]
    public async Task A_redirect_is_reported_not_followed()
    {
        var handler = new FakeHandler((_, _) =>
        {
            var r = new HttpResponseMessage(HttpStatusCode.MovedPermanently);
            r.Headers.Location = new Uri("https://elsewhere.example/upload");
            return r;
        });
        using var http = Http.Create("t/1", TimeSpan.FromSeconds(30), handler);
        var r = await new AgentUploader(http, Api, "pak_TESTKEY_0123456789abcdef").UploadAsync("PJR1.xml", [1], CancellationToken.None);
        Assert.Equal(UploadVerdict.TryAgain, r.Verdict);
        Assert.Contains("elsewhere.example", r.Detail);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task A_network_failure_is_tried_again_and_never_mentions_the_key()
    {
        var handler = new FakeHandler((_, _) => throw new HttpRequestException("connection reset"));
        using var http = Http.Create("t/1", TimeSpan.FromSeconds(30), handler);
        var r = await new AgentUploader(http, Api, "pak_TESTKEY_0123456789abcdef").UploadAsync("PJR1.xml", [1], CancellationToken.None);
        Assert.Equal(UploadVerdict.TryAgain, r.Verdict);
        Assert.DoesNotContain("pak_", r.Detail);
    }

    [Fact]
    public void The_user_agent_carries_the_version()
    {
        Assert.Matches(@"^dinerobook-processor/\d+\.\d+\.\d+$", Http.UserAgent("dinerobook-processor", typeof(Http).Assembly));
    }
}

public class ConnectionCheckTests
{
    private static readonly Uri Api = new("https://dinerobook.com");

    [Fact]
    public async Task Reachable_reads_the_health_route()
    {
        var handler = new FakeHandler((_, _) => FakeHandler.Json(200, """{"status":"ok","version":"2.0.0"}"""));
        using var http = Http.Create("t/1", TimeSpan.FromSeconds(30), handler);
        var r = await ConnectionCheck.ReachableAsync(http, Api, CancellationToken.None);
        Assert.True(r.Ok);
        Assert.Equal("https://dinerobook.com/api/v2/health", handler.Requests.Single().Request.RequestUri!.ToString());
    }

    [Fact]
    public async Task Something_else_answering_is_not_dinerobook()
    {
        var handler = new FakeHandler((_, _) => FakeHandler.Json(200, "<html/>"));
        using var http = Http.Create("t/1", TimeSpan.FromSeconds(30), handler);
        Assert.False((await ConnectionCheck.ReachableAsync(http, Api, CancellationToken.None)).Ok);
    }

    [Theory]
    [InlineData(422, """{"detail":"content_base64 is not valid base64."}""", true)]
    [InlineData(401, """{"detail":"Invalid agent key."}""", false)]
    [InlineData(403, """{"detail":"This store has been disabled. Contact support.","reason":"store_disabled"}""", false)]
    [InlineData(422, """{"detail":"File too large."}""", false)]
    [InlineData(200, """{"staged":true,"duplicate":false,"business_date":null,"parse_error":"x"}""", false)]
    public async Task The_key_check_sends_content_that_cannot_be_stored(int status, string answer, bool ok)
    {
        var handler = new FakeHandler((_, _) => FakeHandler.Json(status, answer));
        using var http = Http.Create("t/1", TimeSpan.FromSeconds(30), handler);
        var r = await ConnectionCheck.KeyAsync(http, Api, "pak_TESTKEY_0123456789abcdef", CancellationToken.None);
        Assert.Equal(ok, r.Ok);
        var body = JsonDocument.Parse(handler.Requests.Single().Body).RootElement;
        // "!" is not base64: the server refuses it before storing anything.
        Assert.Equal("!", body.GetProperty("content_base64").GetString());
    }
}
