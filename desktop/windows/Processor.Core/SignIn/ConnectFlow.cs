namespace DineroBook.Processor.SignIn;

/// <summary>The questions the sign-in may have to ask on the way. Null
/// means the person cancelled.</summary>
public interface IConnectPrompts
{
    /// <summary>The same username and password work at several stores.</summary>
    Task<AccountChoice?> ChooseAccountAsync(IReadOnlyList<AccountChoice> accounts, CancellationToken ct);

    /// <summary>The 6-digit code (or a recovery code). <paramref name="problem"/>
    /// is why the previous code was refused, empty the first time.</summary>
    Task<CodeEntry?> AskForCodeAsync(bool hasRecoveryCodes, string problem, CancellationToken ct);

    /// <summary>"Which store is this computer at?" — an owner with several.</summary>
    Task<StoreChoice?> ChooseStoreAsync(IReadOnlyList<StoreChoice> stores, CancellationToken ct);

    /// <summary>Progress, for the dialog's status line.</summary>
    void Progress(string message);
}

public sealed record CodeEntry(string Code, bool IsRecoveryCode);

/// <summary>Where the new key goes: the Manager saves it (DPAPI) and
/// records the store in settings.json. Throws when it cannot.</summary>
public interface IKeySink
{
    void Save(IssuedKey key, ConnectedStore store);
}

public sealed record ConnectedStore(int StoreId, string StoreName, string ConnectedBy);

/// <summary>The key this computer had before, to revoke once the new one is
/// saved.</summary>
public sealed record PreviousKey(int KeyId, int? StoreId);

public sealed record ConnectResult(bool Ok, bool Cancelled, string Message, ConnectedStore? Store, IReadOnlyList<string> Notes)
{
    public static ConnectResult Fail(string message) => new(false, false, message, null, []);
    public static ConnectResult Cancel() => new(false, true, "Sign-in cancelled.", null, []);
}

/// <summary>
/// "Sign in" in DineroBook Manager, start to finish:
/// <list type="number">
/// <item>/auth/login-cross-store with username and password (409
/// store_ambiguous → pick the account → /auth/login with its store_id; a
/// 6-digit code → /auth/login/totp or /auth/login/recovery);</item>
/// <item>an owner picks the store this computer is at (/auth/my-stores,
/// then /auth/switch-store); a store login already names its store;</item>
/// <item>/posimport/agent-keys issues the store's agent key (needs
/// day_close.update), the key is saved, the previous one revoked;</item>
/// <item>/auth/logout ends the sign-in, whatever happened. The password
/// and the sign-in tokens are never stored.</item>
/// </list>
/// </summary>
public sealed class ConnectFlow(DineroBookClient client, IConnectPrompts prompts, IKeySink sink, RateWindow signInGuard, TimeProvider? time = null)
{
    private const int MaxCodeTries = 5;
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public const string NotAStoreLogin =
        "Sign in with the store's admin or owner login. (A DineroBook platform login cannot connect a register.)";

    public const string NeedsDayClosePermission =
        "This login cannot connect the register: it needs the Day close \"edit\" permission. Ask the store's admin or owner to sign in here.";

    public const string TwoStepInWebApp =
        "This login must finish setting up two-step sign-in in the DineroBook web app first. Then sign in here again.";

    /// <summary>The label the key gets on the store's Register import page.</summary>
    public static string KeyLabel(string computerName)
    {
        var label = $"{computerName} – DineroBook Processor";
        return label.Length <= ServerContract.MaxKeyLabelLength ? label : label[..ServerContract.MaxKeyLabelLength];
    }

    public async Task<ConnectResult> RunAsync(string username, string password, string keyLabel, PreviousKey? previous, CancellationToken ct)
    {
        SignedIn? login = null;
        try
        {
            var answer = await GuardedAsync(() => client.LoginCrossStoreAsync(username, password, ct)).ConfigureAwait(false);
            var codeTries = 0;
            var codeProblem = "";
            while (login is null)
            {
                switch (answer)
                {
                    case SignedIn s:
                        login = s;
                        break;
                    case ChooseAccount choose:
                        var account = await prompts.ChooseAccountAsync(choose.Accounts, ct).ConfigureAwait(false);
                        if (account is null) return ConnectResult.Cancel();
                        prompts.Progress("Signing in…");
                        answer = await GuardedAsync(() => client.LoginAtStoreAsync(username, password, account.StoreId, ct)).ConfigureAwait(false);
                        break;
                    case NeedsCode needs:
                        if (codeTries >= MaxCodeTries) return ConnectResult.Fail("Too many codes tried. Start the sign-in again.");
                        var code = await prompts.AskForCodeAsync(needs.HasRecoveryCodes, codeProblem, ct).ConfigureAwait(false);
                        if (code is null) return ConnectResult.Cancel();
                        codeTries++;
                        prompts.Progress("Checking the code…");
                        var next = await GuardedAsync(() => code.IsRecoveryCode
                            ? client.LoginRecoveryAsync(needs.PendingToken, code.Code.Trim(), ct)
                            : client.LoginTotpAsync(needs.PendingToken, code.Code.Trim(), ct)).ConfigureAwait(false);
                        if (next is LoginRefused { Reason: RefusalReason.BadCode } bad)
                        {
                            codeProblem = bad.Message;
                            answer = needs; // ask again with the same pending token
                        }
                        else
                        {
                            answer = next;
                        }
                        break;
                    case NeedsTwoStepSetup:
                        return ConnectResult.Fail(TwoStepInWebApp);
                    case LoginRefused refused:
                        return ConnectResult.Fail(refused.Message);
                    default:
                        return ConnectResult.Fail("Unexpected sign-in answer.");
                }
            }

            return await ConnectAsync(login, keyLabel, previous, ct).ConfigureAwait(false);
        }
        finally
        {
            if (login is not null)
            {
                // Always end the sign-in, even when a later step failed or
                // was cancelled. Not tied to the dialog's token.
                using var logoutTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                await client.LogoutAsync(login.RefreshJti, logoutTimeout.Token).ConfigureAwait(false);
            }
        }
    }

    private async Task<ConnectResult> ConnectAsync(SignedIn login, string keyLabel, PreviousKey? previous, CancellationToken ct)
    {
        // ── Which store ──
        string storeToken;
        int storeId;
        string storeName;
        IReadOnlyList<StoreChoice> ownerStores = [];
        if (login.Role == "owner")
        {
            prompts.Progress("Reading your stores…");
            var mine = await client.MyStoresAsync(login.AccessToken, ct).ConfigureAwait(false);
            if (!mine.Ok) return ConnectResult.Fail(mine.Message);
            ownerStores = mine.Value!;
            if (ownerStores.Count == 0) return ConnectResult.Fail("This owner login has no active store.");
            var pick = ownerStores.Count == 1
                ? ownerStores[0]
                : await prompts.ChooseStoreAsync(ownerStores, ct).ConfigureAwait(false);
            if (pick is null) return ConnectResult.Cancel();
            prompts.Progress($"Opening {pick.Name}…");
            var entered = await client.SwitchStoreAsync(login.AccessToken, pick.StoreId, ct).ConfigureAwait(false);
            if (!entered.Ok) return ConnectResult.Fail(entered.Message);
            storeToken = entered.Value!.AccessToken;
            storeId = entered.Value.StoreId;
            storeName = entered.Value.StoreName.Length > 0 ? entered.Value.StoreName : pick.Name;
        }
        else if (login.StoreId is { } own && login.Role is not ("superadmin" or "support"))
        {
            storeToken = login.AccessToken;
            storeId = own;
            storeName = $"Store {own}";
            // The store's name, and the permission check before any write.
            var session = await client.SessionStatusAsync(login.AccessToken, ct).ConfigureAwait(false);
            if (session.Ok)
            {
                if (session.Value!.StoreName.Length > 0) storeName = session.Value.StoreName;
                if (!session.Value.Permissions.Contains(ServerContract.AgentKeyPermission))
                {
                    return ConnectResult.Fail(NeedsDayClosePermission);
                }
            }
        }
        else
        {
            return ConnectResult.Fail(NotAStoreLogin);
        }

        // ── The key ──
        prompts.Progress($"Connecting this computer to {storeName}…");
        var issued = await client.IssueAgentKeyAsync(storeToken, keyLabel, ct).ConfigureAwait(false);
        if (!issued.Ok)
        {
            return ConnectResult.Fail(issued.Status == 403 ? NeedsDayClosePermission : issued.Message);
        }
        var store = new ConnectedStore(storeId, storeName, login.Username);
        try
        {
            sink.Save(issued.Value!, store);
        }
        catch (Exception ex)
        {
            // Never leave a working key behind that nothing holds.
            await client.RevokeAgentKeyAsync(storeToken, issued.Value!.Id, CancellationToken.None).ConfigureAwait(false);
            return ConnectResult.Fail("The key could not be saved on this computer: " + ex.Message);
        }

        // ── The old key ──
        var notes = new List<string>();
        if (previous is not null && previous.KeyId != issued.Value!.Id)
        {
            prompts.Progress("Revoking the old key…");
            string? tokenForOld = null;
            if (previous.StoreId == storeId)
            {
                tokenForOld = storeToken;
            }
            else if (login.Role == "owner" && previous.StoreId is { } oldStore && ownerStores.Any(s => s.StoreId == oldStore))
            {
                var back = await client.SwitchStoreAsync(login.AccessToken, oldStore, ct).ConfigureAwait(false);
                tokenForOld = back.Value?.AccessToken;
            }
            var revoked = tokenForOld is null
                ? null
                : await client.RevokeAgentKeyAsync(tokenForOld, previous.KeyId, ct).ConfigureAwait(false);
            if (revoked is not { Ok: true } && revoked?.Status != 404)
            {
                notes.Add("The previous key could not be revoked from here. Revoke it in DineroBook: Register import → Automatic uploads.");
            }
        }

        return new ConnectResult(true, false, $"This computer now sends {storeName}'s register files.", store, notes);
    }

    /// <summary>One sign-in call, unless this computer already made the
    /// server's limit's worth in the last minute.</summary>
    private async Task<LoginAnswer> GuardedAsync(Func<Task<LoginAnswer>> call)
    {
        var now = _time.GetUtcNow();
        if (signInGuard.WaitBeforeNext(now) > TimeSpan.Zero)
        {
            return new LoginRefused(RefusalReason.TooManyAttempts, "Too many sign-in attempts. Wait a minute and try again.");
        }
        signInGuard.Record(now);
        return await call().ConfigureAwait(false);
    }
}
