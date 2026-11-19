using System.Net;
using System.Text.Json;
using DineroBook.Processor;
using DineroBook.Processor.SignIn;
using Xunit;

namespace Processor.Tests;

/// <summary>Every answer the sign-in routes give, in the server's shapes
/// (api/Modules/Auth/Requests/login.py :: LoginResponse and the
/// HTTPException details in api/Modules/Auth/Controllers).</summary>
public class LoginAnswersTests
{
    [Fact]
    public void Full_sign_in()
    {
        var a = LoginAnswers.Parse(200, """
            {"access_token":"eyJ.a.b","token_type":"Bearer","expires_in":1800,"user_id":12,"username":"maria",
             "full_name":"Maria P","role":"admin","store_id":3,"permissions":["day_close.update","reports.read"],
             "requires_totp":false,"pending_token":null,"has_recovery_codes":false,"enroll_required":false,
             "refresh_jti":"rj-123"}
            """, LoginStep.Password);
        var s = Assert.IsType<SignedIn>(a);
        Assert.Equal("eyJ.a.b", s.AccessToken);
        Assert.Equal("rj-123", s.RefreshJti);
        Assert.Equal(12, s.UserId);
        Assert.Equal("admin", s.Role);
        Assert.Equal(3, s.StoreId);
        Assert.Contains("day_close.update", s.Permissions);
        Assert.DoesNotContain("eyJ", s.ToString());
    }

    [Fact]
    public void An_owner_with_no_home_store()
    {
        var s = Assert.IsType<SignedIn>(LoginAnswers.Parse(200,
            """{"access_token":"t","user_id":5,"username":"o@x.com","role":"owner","store_id":null,"permissions":["owner.read"],"requires_totp":false}""",
            LoginStep.Password));
        Assert.Equal("owner", s.Role);
        Assert.Null(s.StoreId);
        Assert.Null(s.RefreshJti);
    }

    [Fact]
    public void Two_step_code_needed()
    {
        var a = LoginAnswers.Parse(200, """
            {"access_token":"","user_id":1,"requires_totp":true,"pending_token":"pend.ing","has_recovery_codes":true,"enroll_required":false}
            """, LoginStep.Password);
        var n = Assert.IsType<NeedsCode>(a);
        Assert.Equal("pend.ing", n.PendingToken);
        Assert.True(n.HasRecoveryCodes);
    }

    [Fact]
    public void Two_step_not_set_up_yet()
    {
        Assert.IsType<NeedsTwoStepSetup>(LoginAnswers.Parse(200,
            """{"access_token":"","user_id":1,"requires_totp":true,"pending_token":"p","has_recovery_codes":false,"enroll_required":true}""",
            LoginStep.Password));
    }

    [Fact]
    public void The_enrollment_409_is_a_sentence()
    {
        Assert.IsType<NeedsTwoStepSetup>(LoginAnswers.Parse(409, """{"detail":"Finish 2FA enrollment first."}""", LoginStep.Password));
    }

    [Fact]
    public void Store_ambiguous()
    {
        var a = LoginAnswers.Parse(409, """
            {"detail":{"code":"store_ambiguous","message":"Choose which store to sign in to",
             "stores":[{"store_id":3,"store_name":"Main St","role":"admin"},{"store_id":9,"store_name":"Elm Ave","role":"employee"}]}}
            """, LoginStep.Password);
        var c = Assert.IsType<ChooseAccount>(a);
        Assert.Equal([new AccountChoice(3, "Main St", "admin"), new AccountChoice(9, "Elm Ave", "employee")], c.Accounts);
        Assert.Equal("Main St (admin)", c.Accounts[0].ToString());
    }

    [Fact]
    public void Wrong_password_is_the_one_opaque_message()
    {
        var r = Assert.IsType<LoginRefused>(LoginAnswers.Parse(401, """{"detail":"Invalid username or password"}""", LoginStep.Password));
        Assert.Equal(RefusalReason.BadCredentials, r.Reason);
        Assert.Equal("Invalid username or password", r.Message);
        // Whatever the server says, the text stays the same opaque one.
        var other = Assert.IsType<LoginRefused>(LoginAnswers.Parse(401, """{"detail":"Account is disabled"}""", LoginStep.Password));
        Assert.Equal("Invalid username or password", other.Message);
    }

    [Theory]
    [InlineData(LoginStep.Code)]
    [InlineData(LoginStep.RecoveryCode)]
    public void A_wrong_code_is_a_code_problem(LoginStep step)
    {
        var r = Assert.IsType<LoginRefused>(LoginAnswers.Parse(401, """{"detail":"Invalid verification code"}""", step));
        Assert.Equal(RefusalReason.BadCode, r.Reason);
    }

    [Fact]
    public void Disabled_store()
    {
        var r = Assert.IsType<LoginRefused>(LoginAnswers.Parse(403, """{"detail":"This store has been disabled. Contact support."}""", LoginStep.Password));
        Assert.Equal(RefusalReason.StoreDisabled, r.Reason);
        Assert.Equal("This store has been disabled. Contact support.", r.Message);
    }

    [Fact]
    public void Too_many_attempts()
    {
        var r = Assert.IsType<LoginRefused>(LoginAnswers.Parse(429, """{"detail":"Too many requests — try again in a moment.","limit":"10 per 1 minute"}""", LoginStep.Password));
        Assert.Equal(RefusalReason.TooManyAttempts, r.Reason);
    }

    [Theory]
    [InlineData(500, "Internal Server Error", RefusalReason.ServerError)]
    [InlineData(502, "<html>Bad gateway</html>", RefusalReason.ServerError)]
    [InlineData(422, """{"detail":[{"loc":["body","password"],"msg":"String should have at least 1 character"}]}""", RefusalReason.Unexpected)]
    [InlineData(200, "<html/>", RefusalReason.Unexpected)]
    [InlineData(200, """{"access_token":""}""", RefusalReason.Unexpected)]
    [InlineData(409, """{"detail":{"code":"something_new"}}""", RefusalReason.Unexpected)]
    public void Anything_else_is_refused_with_a_reason(int status, string body, RefusalReason reason)
    {
        Assert.Equal(reason, Assert.IsType<LoginRefused>(LoginAnswers.Parse(status, body, LoginStep.Password)).Reason);
    }
}

/// <summary>A small DineroBook for the connect flow: users, stores, keys,
/// answering in the server's shapes.</summary>
internal sealed class FakeDineroBook
{
    public sealed record User(string Username, string Password, string Role, int? StoreId, string? Totp = null);

    public readonly List<User> Users = new();
    public readonly Dictionary<int, string> Stores = new() { [3] = "Main St", [9] = "Elm Ave" };
    public readonly Dictionary<string, List<int>> OwnerStores = new();
    public readonly Dictionary<string, string[]> Perms = new();
    public readonly List<(int Id, int Store, string Label, bool Revoked)> Keys = new();
    public readonly List<string> LoggedOut = new();
    public readonly List<string> Calls = new();
    public readonly FakeHandler Handler;
    private int _nextKey = 40;

    public FakeDineroBook() => Handler = new FakeHandler(Answer);

    private static HttpResponseMessage J(int status, object body) => FakeHandler.Json(status, JsonSerializer.Serialize(body));

    private static string Token(User u, int? store) => $"tok|{u.Username}|{u.Role}|{store}";

    private static object Login(User u) => new
    {
        access_token = Token(u, u.StoreId),
        token_type = "Bearer",
        expires_in = 1800,
        user_id = 1,
        username = u.Username,
        full_name = "",
        role = u.Role,
        store_id = u.StoreId,
        permissions = Array.Empty<string>(),
        requires_totp = false,
        pending_token = (string?)null,
        has_recovery_codes = false,
        enroll_required = false,
        refresh_jti = "rj-" + u.Username,
    };

    private HttpResponseMessage PasswordLogin(List<User> matches)
    {
        if (matches.Count == 0) return J(401, new { detail = "Invalid username or password" });
        if (matches.Count > 1)
        {
            return J(409, new
            {
                detail = new
                {
                    code = "store_ambiguous",
                    message = "Choose which store to sign in to",
                    stores = matches.Select(m => new { store_id = m.StoreId, store_name = Stores.GetValueOrDefault(m.StoreId ?? 0, ""), role = m.Role }),
                },
            });
        }
        var u = matches[0];
        if (u.Totp is not null)
        {
            return J(200, new { access_token = "", user_id = 1, requires_totp = true, pending_token = "pending|" + u.Username, has_recovery_codes = true, enroll_required = false });
        }
        return J(200, Login(u));
    }

    private HttpResponseMessage Answer(HttpRequestMessage req, string body)
    {
        var path = req.RequestUri!.AbsolutePath;
        Calls.Add(req.Method + " " + path);
        var json = body.Length > 0 ? JsonDocument.Parse(body).RootElement : default;
        var auth = req.Headers.Authorization?.Parameter;
        var who = auth?.Split('|');
        switch (path)
        {
            case "/api/v2/auth/login-cross-store":
                return PasswordLogin(Users.Where(u => u.Username == json.GetProperty("username").GetString()
                                                      && u.Password == json.GetProperty("password").GetString()).ToList());
            case "/api/v2/auth/login":
                int? sid = json.GetProperty("store_id").ValueKind == JsonValueKind.Null ? null : json.GetProperty("store_id").GetInt32();
                return PasswordLogin(Users.Where(u => u.Username == json.GetProperty("username").GetString()
                                                      && u.Password == json.GetProperty("password").GetString()
                                                      && u.StoreId == sid).ToList());
            case "/api/v2/auth/login/totp":
            {
                var name = json.GetProperty("pending_token").GetString()!.Split('|')[1];
                var u = Users.Single(x => x.Username == name);
                return json.GetProperty("code").GetString() == u.Totp
                    ? J(200, Login(u))
                    : J(401, new { detail = "Invalid verification code" });
            }
            case "/api/v2/auth/login/recovery":
            {
                var name = json.GetProperty("pending_token").GetString()!.Split('|')[1];
                var u = Users.Single(x => x.Username == name);
                return json.GetProperty("code").GetString() == "ABCD-EFGH" ? J(200, Login(u)) : J(401, new { detail = "Invalid recovery code" });
            }
            case "/api/v2/auth/logout":
                var cookie = req.Headers.TryGetValues("Cookie", out var c) ? c.Single() : "";
                LoggedOut.Add(cookie);
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            case "/api/v2/auth/my-stores":
            {
                if (who is null || who[2] != "owner") return J(403, new { detail = "Only owners can switch stores." });
                var ids = OwnerStores.GetValueOrDefault(who[1], new List<int>());
                return J(200, new { stores = ids.Select(i => new { store_id = i, name = Stores[i], slug = "s" + i, address = i + " Road", is_current = false, is_home = false }) });
            }
            case "/api/v2/auth/switch-store":
            {
                if (who is null || (who[2] != "owner" && !who[1].StartsWith("owner"))) return J(403, new { detail = "Only owners can switch stores." });
                var target = json.GetProperty("store_id").GetInt32();
                if (!OwnerStores.GetValueOrDefault(who[1], new List<int>()).Contains(target)) return J(404, new { detail = "Store not found" });
                return J(200, new
                {
                    access_token = $"tok|{who[1]}|admin|{target}", store_id = target, store_name = Stores[target], role = "admin",
                    expires_in = 1800, user_id = 1, username = who[1], full_name = "", permissions = new[] { "day_close.update" }, owner_id = 1, refresh_jti = (string?)null,
                });
            }
            case "/api/v2/auth/session-status":
            {
                var store = who is null || who[3] == "" ? (int?)null : int.Parse(who[3]);
                return J(200, new
                {
                    gated = false, reason = "", impersonation = (object?)null, plan = "trial",
                    store_name = store is { } s ? Stores[s] : "", timezone = "", business_type = "cstore", features = Array.Empty<string>(),
                    permissions = Perms.GetValueOrDefault(who![1], who[2] == "admin" ? ["day_close.update", "day_close.read"] : ["day_close.read"]),
                    trial = (object?)null,
                });
            }
            case "/api/v2/posimport/agent-keys":
            {
                var store = who is null || who[3] == "" ? (int?)null : int.Parse(who[3]);
                if (store is null) return J(403, new { detail = "No store scope on this token." });
                if (who![2] != "admin") return J(403, new { detail = "Missing permission: day_close.update" });
                var id = _nextKey++;
                var label = json.GetProperty("label").GetString()!;
                Keys.Add((id, store.Value, label, false));
                return J(201, new { id, label, key = "pak_ISSUED_" + id + "_0123456789abcdefghijklmnopqrstu" });
            }
            default:
                if (path.StartsWith("/api/v2/posimport/agent-keys/") && path.EndsWith("/revoke"))
                {
                    var id = int.Parse(path.Split('/')[5]);
                    var store = int.Parse(who![3]);
                    var i = Keys.FindIndex(k => k.Id == id && k.Store == store);
                    if (i < 0) return J(404, new { detail = "Agent key not found" });
                    Keys[i] = Keys[i] with { Revoked = true };
                    return J(200, new { keys = Array.Empty<object>() });
                }
                return J(404, new { detail = "Not Found" });
        }
    }
}

internal sealed class ScriptedPrompts : IConnectPrompts
{
    public Func<IReadOnlyList<AccountChoice>, AccountChoice?> Account = a => a[0];
    public Queue<CodeEntry?> Codes = new();
    public Func<IReadOnlyList<StoreChoice>, StoreChoice?> Store = s => s[0];
    public readonly List<string> Asked = new();

    public Task<AccountChoice?> ChooseAccountAsync(IReadOnlyList<AccountChoice> accounts, CancellationToken ct)
    {
        Asked.Add("account");
        return Task.FromResult(Account(accounts));
    }

    public Task<CodeEntry?> AskForCodeAsync(bool hasRecoveryCodes, string problem, CancellationToken ct)
    {
        Asked.Add("code:" + problem);
        return Task.FromResult(Codes.Count > 0 ? Codes.Dequeue() : null);
    }

    public Task<StoreChoice?> ChooseStoreAsync(IReadOnlyList<StoreChoice> stores, CancellationToken ct)
    {
        Asked.Add("store:" + string.Join(",", stores.Select(s => s.Name)));
        return Task.FromResult(Store(stores));
    }

    public void Progress(string message) { }
}

internal sealed class MemorySink : IKeySink
{
    public IssuedKey? Key;
    public ConnectedStore? Store;
    public bool Fail;

    public void Save(IssuedKey key, ConnectedStore store)
    {
        if (Fail) throw new UnauthorizedAccessException("Access to the path is denied.");
        Key = key;
        Store = store;
    }
}

public class ConnectFlowTests
{
    private readonly FakeDineroBook _server = new();
    private readonly ScriptedPrompts _prompts = new();
    private readonly MemorySink _sink = new();

    private Task<ConnectResult> Run(string user, string password, PreviousKey? previous = null, RateWindow? guard = null)
    {
        var client = new DineroBookClient(new Uri("https://dinerobook.com"), "dinerobook-manager/0.1.0", _server.Handler);
        var flow = new ConnectFlow(client, _prompts, _sink, guard ?? new RateWindow(8, TimeSpan.FromMinutes(1)));
        return flow.RunAsync(user, password, ConnectFlow.KeyLabel("BOPC-01"), previous, CancellationToken.None);
    }

    [Fact]
    public async Task A_store_admin_connects_their_own_store()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3));
        var r = await Run("maria", "pw");
        Assert.True(r.Ok, r.Message);
        Assert.Equal(new ConnectedStore(3, "Main St", "maria"), r.Store);
        Assert.Equal("BOPC-01 – DineroBook Processor", _sink.Key!.Label);
        Assert.StartsWith("pak_", _sink.Key.Key);
        Assert.Equal(["db_refresh_token=rj-maria"], _server.LoggedOut);
        Assert.Empty(_prompts.Asked);
        Assert.Equal("POST /api/v2/auth/logout", _server.Calls[^1]);
    }

    [Fact]
    public async Task Requests_carry_the_bearer_token_from_the_json_and_no_cookie()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3));
        await Run("maria", "pw");
        var issue = _server.Handler.Requests.Single(x => x.Request.RequestUri!.AbsolutePath == "/api/v2/posimport/agent-keys");
        Assert.Equal("Bearer", issue.Request.Headers.Authorization!.Scheme);
        Assert.Equal("tok|maria|admin|3", issue.Request.Headers.Authorization.Parameter);
        Assert.False(issue.Request.Headers.Contains("Cookie"));
        Assert.Equal("""{"label":"BOPC-01 – DineroBook Processor"}""", JsonSerializer.Serialize(JsonDocument.Parse(issue.Body).RootElement,
            new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        var login = _server.Handler.Requests.First();
        Assert.Equal(["username", "password"], JsonDocument.Parse(login.Body).RootElement.EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task Wrong_password_says_the_opaque_thing_and_signs_nothing_out()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3));
        var r = await Run("maria", "nope");
        Assert.False(r.Ok);
        Assert.Equal("Invalid username or password", r.Message);
        Assert.Empty(_server.LoggedOut);
        Assert.Null(_sink.Key);
    }

    [Fact]
    public async Task An_owner_with_two_stores_is_asked_which_store_this_computer_is_at()
    {
        _server.Users.Add(new("owner@x.com", "pw", "owner", null));
        _server.OwnerStores["owner@x.com"] = [3, 9];
        _prompts.Store = s => s.Single(x => x.Name == "Elm Ave");
        var r = await Run("owner@x.com", "pw");
        Assert.True(r.Ok, r.Message);
        Assert.Equal(["store:Main St,Elm Ave"], _prompts.Asked);
        Assert.Equal(9, r.Store!.StoreId);
        Assert.Equal("Elm Ave", r.Store.StoreName);
        Assert.Equal(9, _server.Keys.Single().Store);
        Assert.Contains("POST /api/v2/auth/switch-store", _server.Calls);
        Assert.Equal(["db_refresh_token=rj-owner@x.com"], _server.LoggedOut);
    }

    [Fact]
    public async Task An_owner_with_one_store_is_not_asked()
    {
        _server.Users.Add(new("owner@x.com", "pw", "owner", 3));
        _server.OwnerStores["owner@x.com"] = [3];
        var r = await Run("owner@x.com", "pw");
        Assert.True(r.Ok, r.Message);
        Assert.Empty(_prompts.Asked);
        Assert.Equal(3, r.Store!.StoreId);
    }

    [Fact]
    public async Task An_owner_with_no_active_store_is_told_and_signed_out()
    {
        _server.Users.Add(new("owner@x.com", "pw", "owner", null));
        var r = await Run("owner@x.com", "pw");
        Assert.False(r.Ok);
        Assert.Contains("no active store", r.Message);
        Assert.Single(_server.LoggedOut);
    }

    [Fact]
    public async Task Cancelling_the_store_question_still_signs_out()
    {
        _server.Users.Add(new("owner@x.com", "pw", "owner", null));
        _server.OwnerStores["owner@x.com"] = [3, 9];
        _prompts.Store = _ => null;
        var r = await Run("owner@x.com", "pw");
        Assert.True(r.Cancelled);
        Assert.Empty(_server.Keys);
        Assert.Single(_server.LoggedOut);
    }

    [Fact]
    public async Task The_same_login_at_two_stores_picks_the_account_then_signs_in_there()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3));
        _server.Users.Add(new("maria", "pw", "admin", 9));
        _prompts.Account = a => a.Single(x => x.StoreId == 9);
        var r = await Run("maria", "pw");
        Assert.True(r.Ok, r.Message);
        Assert.Equal(["account"], _prompts.Asked);
        Assert.Equal(9, r.Store!.StoreId);
        var second = _server.Handler.Requests.Single(x => x.Request.RequestUri!.AbsolutePath == "/api/v2/auth/login");
        Assert.Equal(9, JsonDocument.Parse(second.Body).RootElement.GetProperty("store_id").GetInt32());
    }

    [Fact]
    public async Task A_six_digit_code_is_asked_for_and_a_wrong_one_asked_again()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3, Totp: "123456"));
        _prompts.Codes = new([new CodeEntry("000000", false), new CodeEntry(" 123456 ", false)]);
        var r = await Run("maria", "pw");
        Assert.True(r.Ok, r.Message);
        Assert.Equal(2, _prompts.Asked.Count);
        Assert.Equal("code:", _prompts.Asked[0]);
        Assert.Contains("That code did not work", _prompts.Asked[1]);
        var totp = _server.Handler.Requests.Where(x => x.Request.RequestUri!.AbsolutePath == "/api/v2/auth/login/totp").ToList();
        Assert.Equal(2, totp.Count);
        Assert.Equal("123456", JsonDocument.Parse(totp[1].Body).RootElement.GetProperty("code").GetString());
        Assert.Equal("pending|maria", JsonDocument.Parse(totp[1].Body).RootElement.GetProperty("pending_token").GetString());
    }

    [Fact]
    public async Task A_recovery_code_goes_to_the_recovery_route()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3, Totp: "123456"));
        _prompts.Codes = new([new CodeEntry("ABCD-EFGH", true)]);
        var r = await Run("maria", "pw");
        Assert.True(r.Ok, r.Message);
        Assert.Contains("POST /api/v2/auth/login/recovery", _server.Calls);
        Assert.DoesNotContain("POST /api/v2/auth/login/totp", _server.Calls);
    }

    [Fact]
    public async Task A_login_without_the_day_close_permission_is_stopped_before_any_write()
    {
        _server.Users.Add(new("amber", "pw", "employee", 3));
        var r = await Run("amber", "pw");
        Assert.False(r.Ok);
        Assert.Equal(ConnectFlow.NeedsDayClosePermission, r.Message);
        Assert.DoesNotContain("POST /api/v2/posimport/agent-keys", _server.Calls);
        Assert.Single(_server.LoggedOut);
    }

    [Fact]
    public async Task A_403_on_the_key_says_ask_the_admin_or_owner()
    {
        _server.Users.Add(new("amber", "pw", "employee", 3));
        _server.Perms["amber"] = ["day_close.update"]; // the pre-check passes; the server still says no
        var r = await Run("amber", "pw");
        Assert.False(r.Ok);
        Assert.Equal(ConnectFlow.NeedsDayClosePermission, r.Message);
        Assert.Single(_server.LoggedOut);
    }

    [Fact]
    public async Task A_platform_login_is_sent_to_the_store_login()
    {
        _server.Users.Add(new("superadmin", "pw", "superadmin", null));
        var r = await Run("superadmin", "pw");
        Assert.False(r.Ok);
        Assert.Equal(ConnectFlow.NotAStoreLogin, r.Message);
        Assert.Empty(_server.Keys);
        Assert.Single(_server.LoggedOut);
    }

    [Fact]
    public async Task Sign_in_again_revokes_the_previous_key_at_the_same_store()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3));
        _server.Keys.Add((7, 3, "old", false));
        var r = await Run("maria", "pw", new PreviousKey(7, 3));
        Assert.True(r.Ok, r.Message);
        Assert.Empty(r.Notes);
        Assert.True(_server.Keys.Single(k => k.Id == 7).Revoked);
        Assert.False(_server.Keys.Single(k => k.Id != 7).Revoked);
    }

    [Fact]
    public async Task An_owner_moving_the_computer_to_another_store_revokes_the_old_stores_key()
    {
        _server.Users.Add(new("owner@x.com", "pw", "owner", null));
        _server.OwnerStores["owner@x.com"] = [3, 9];
        _server.Keys.Add((7, 3, "old", false));
        _prompts.Store = s => s.Single(x => x.StoreId == 9);
        var r = await Run("owner@x.com", "pw", new PreviousKey(7, 3));
        Assert.True(r.Ok, r.Message);
        Assert.True(_server.Keys.Single(k => k.Id == 7).Revoked);
    }

    [Fact]
    public async Task An_old_key_that_cannot_be_revoked_from_here_leaves_a_note()
    {
        _server.Users.Add(new("maria", "pw", "admin", 9));
        _server.Keys.Add((7, 3, "old", false));
        var r = await Run("maria", "pw", new PreviousKey(7, 3));
        Assert.True(r.Ok, r.Message);
        Assert.Contains("Register import", Assert.Single(r.Notes));
        Assert.False(_server.Keys.Single(k => k.Id == 7).Revoked);
    }

    [Fact]
    public async Task If_the_key_cannot_be_saved_it_is_revoked_at_once()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3));
        _sink.Fail = true;
        var r = await Run("maria", "pw");
        Assert.False(r.Ok);
        Assert.Contains("could not be saved", r.Message);
        Assert.True(_server.Keys.Single().Revoked);
        Assert.Single(_server.LoggedOut);
    }

    [Fact]
    public async Task Stays_under_the_sign_in_limit()
    {
        _server.Users.Add(new("maria", "pw", "admin", 3));
        var guard = new RateWindow(2, TimeSpan.FromMinutes(1));
        Assert.False((await Run("maria", "x", guard: guard)).Ok);
        Assert.False((await Run("maria", "x", guard: guard)).Ok);
        var third = await Run("maria", "pw", guard: guard);
        Assert.False(third.Ok);
        Assert.Contains("Too many sign-in attempts", third.Message);
        Assert.Equal(2, _server.Calls.Count(c => c.EndsWith("login-cross-store")));
    }

    [Fact]
    public void The_key_label_fits_the_servers_80_characters()
    {
        Assert.Equal("BOPC – DineroBook Processor", ConnectFlow.KeyLabel("BOPC"));
        Assert.Equal(80, ConnectFlow.KeyLabel(new string('X', 200)).Length);
    }
}

public class RollingFileLoggerTests
{
    [Fact]
    public void Writes_one_file_a_day_and_drops_old_ones()
    {
        using var dir = new TempDir();
        // Noon UTC is the 18th in every time zone the store PCs use.
        var now = new DateTimeOffset(2026, 11, 18, 12, 0, 0, TimeSpan.Zero);
        File.WriteAllText(Path.Combine(dir.Path, "processor-20261101.log"), "old");
        File.WriteAllText(Path.Combine(dir.Path, "processor-20261110.log"), "recent");
        using (var p = new RollingFileLoggerProvider(dir.Path, now: () => now))
        {
            var log = p.CreateLogger("x");
            Microsoft.Extensions.Logging.LoggerExtensions.LogInformation(log, "first {File}", "PJR1.xml");
            now = now.AddDays(1);
            Microsoft.Extensions.Logging.LoggerExtensions.LogWarning(log, "second\nline");
        }
        var files = Directory.GetFiles(dir.Path).Select(f => Path.GetFileName(f)).Order().ToArray();
        Assert.Equal(["processor-20261110.log", "processor-20261118.log", "processor-20261119.log"], files);
        Assert.Contains("INFO  first PJR1.xml", File.ReadAllText(Path.Combine(dir.Path, "processor-20261118.log")));
        Assert.Contains("WARN  second line", File.ReadAllText(Path.Combine(dir.Path, "processor-20261119.log")));
    }

    [Fact]
    public void The_log_can_be_read_while_it_is_being_written()
    {
        using var dir = new TempDir();
        using var p = new RollingFileLoggerProvider(dir.Path);
        Microsoft.Extensions.Logging.LoggerExtensions.LogInformation(p.CreateLogger("x"), "hello");
        var file = Directory.GetFiles(dir.Path).Single();
        Assert.Contains("hello", AtomicFile.TryReadShared(file));
    }
}
