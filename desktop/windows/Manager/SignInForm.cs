using DineroBook.Processor;
using DineroBook.Processor.SignIn;

namespace DineroBook.Manager;

/// <summary>
/// "Sign in": DineroBook username and password, then whatever the server
/// asks (which store, a 6-digit code), then the store's agent key is saved
/// and the sign-in ended. The password and the sign-in tokens live only in
/// this dialog while it runs; nothing but the agent key is kept.
/// </summary>
internal sealed class SignInForm : Form, IConnectPrompts
{
    // Shared across sign-ins: the server allows 10 a minute per address.
    private static readonly RateWindow SignInGuard = new(8, TimeSpan.FromMinutes(1));

    private readonly DineroBookClient _client;
    private readonly MachineSetup _setup;
    private readonly PreviousKey? _previous;

    private readonly Panel _credentials = new() { Dock = DockStyle.Fill };
    private readonly Panel _choice = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Panel _code = new() { Dock = DockStyle.Fill, Visible = false };

    private readonly TextBox _username = new() { Width = 320, AccessibleName = "Username or email" };
    private readonly TextBox _password = new() { Width = 320, UseSystemPasswordChar = true, AccessibleName = "Password" };
    private readonly Button _signIn = new() { Text = "Sign in", AutoSize = true };

    private readonly Label _choiceQuestion = new() { AutoSize = true, MaximumSize = new Size(400, 0) };
    private readonly ListBox _choiceList = new() { Width = 400, Height = 140, AccessibleName = "Choices" };
    private readonly Button _choiceContinue = new() { Text = "Continue", AutoSize = true };

    private readonly Label _codeQuestion = new() { AutoSize = true, MaximumSize = new Size(400, 0) };
    private readonly Label _codeProblem = new() { AutoSize = true, MaximumSize = new Size(400, 0), ForeColor = Color.Firebrick };
    private readonly TextBox _codeBox = new() { Width = 200, MaxLength = 10, AccessibleName = "Code" };
    private readonly LinkLabel _useRecovery = new() { AutoSize = true, Text = "Use a recovery code instead" };
    private readonly Button _codeContinue = new() { Text = "Continue", AutoSize = true };

    private readonly Label _progress = new() { Dock = DockStyle.Bottom, Height = 48, Padding = new Padding(12, 4, 12, 4) };
    private readonly Button _cancel = new() { Text = "Cancel", AutoSize = true };

    private CancellationTokenSource? _run;
    private TaskCompletionSource<object?>? _waiting;
    private bool _recoveryMode;
    private bool _closeWhenDone;

    public ConnectResult? Result { get; private set; }

    public SignInForm(Uri api, MachineSetup setup, PreviousKey? previous)
    {
        _client = new DineroBookClient(api, Http.UserAgent("dinerobook-manager"));
        _setup = setup;
        _previous = previous;

        Text = "Sign in to DineroBook";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(460, 330);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.75f);

        BuildCredentials(api);
        BuildChoice();
        BuildCode();

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 44, Padding = new Padding(8) };
        bottom.Controls.Add(_cancel);
        Controls.Add(_credentials);
        Controls.Add(_choice);
        Controls.Add(_code);
        Controls.Add(_progress);
        Controls.Add(bottom);
        CancelButton = _cancel;
        AcceptButton = _signIn;

        _signIn.Click += async (_, _) => await SignInAsync();
        _choiceContinue.Click += (_, _) => Answer(_choiceList.SelectedItem);
        _choiceList.DoubleClick += (_, _) => Answer(_choiceList.SelectedItem);
        _codeContinue.Click += (_, _) =>
        {
            if (_codeBox.Text.Trim().Length > 0) Answer(new CodeEntry(_codeBox.Text, _recoveryMode));
        };
        _useRecovery.LinkClicked += (_, _) => SetRecoveryMode(!_recoveryMode);
        _cancel.Click += (_, _) => Close();
        FormClosing += (_, e) =>
        {
            // While a sign-in runs, stop it and close once it has ended
            // (it always signs out on the way).
            if (_run is null) return;
            e.Cancel = true;
            _closeWhenDone = true;
            _progress.Text = "Cancelling…";
            CancelRun();
        };
    }

    private static FlowLayoutPanel Column() => new()
    {
        Dock = DockStyle.Fill,
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        Padding = new Padding(16, 12, 16, 0),
    };

    private void BuildCredentials(Uri api)
    {
        var col = Column();
        col.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            Text = $"Sign in with the store's DineroBook admin or owner login ({api.Host}). " +
                   "The password is not saved; this computer keeps only the store's upload key.",
        });
        col.Controls.Add(new Label { AutoSize = true, Text = "Username or email", Margin = new Padding(0, 12, 0, 0) });
        col.Controls.Add(_username);
        col.Controls.Add(new Label { AutoSize = true, Text = "Password", Margin = new Padding(0, 8, 0, 0) });
        col.Controls.Add(_password);
        _signIn.Margin = new Padding(0, 12, 0, 0);
        col.Controls.Add(_signIn);
        _credentials.Controls.Add(col);
    }

    private void BuildChoice()
    {
        var col = Column();
        col.Controls.Add(_choiceQuestion);
        _choiceList.Margin = new Padding(0, 8, 0, 0);
        col.Controls.Add(_choiceList);
        _choiceContinue.Margin = new Padding(0, 8, 0, 0);
        col.Controls.Add(_choiceContinue);
        _choice.Controls.Add(col);
    }

    private void BuildCode()
    {
        var col = Column();
        col.Controls.Add(_codeQuestion);
        col.Controls.Add(_codeProblem);
        _codeBox.Margin = new Padding(0, 8, 0, 0);
        _codeBox.Font = new Font("Consolas", 14f);
        col.Controls.Add(_codeBox);
        col.Controls.Add(_useRecovery);
        _codeContinue.Margin = new Padding(0, 8, 0, 0);
        col.Controls.Add(_codeContinue);
        _code.Controls.Add(col);
    }

    private void Show(Panel panel, Button accept)
    {
        _credentials.Visible = panel == _credentials;
        _choice.Visible = panel == _choice;
        _code.Visible = panel == _code;
        AcceptButton = accept;
    }

    private async Task SignInAsync()
    {
        var user = _username.Text.Trim();
        var password = _password.Text;
        if (user.Length == 0 || password.Length == 0)
        {
            _progress.Text = "Type the username (or email) and the password.";
            return;
        }
        _signIn.Enabled = false;
        _username.Enabled = false;
        _password.Enabled = false;
        _progress.Text = "Signing in…";
        _run = new CancellationTokenSource();
        try
        {
            var flow = new ConnectFlow(_client, this, _setup.Sink(), SignInGuard);
            Result = await flow.RunAsync(user, password, ConnectFlow.KeyLabel(Environment.MachineName), _previous, _run.Token);
        }
        catch (OperationCanceledException)
        {
            Result = ConnectResult.Cancel();
        }
        catch (Exception ex)
        {
            Result = ConnectResult.Fail("Sign-in failed: " + ex.Message);
        }
        finally
        {
            _password.Text = "";
            _run.Dispose();
            _run = null;
        }

        if (Result.Ok)
        {
            DialogResult = DialogResult.OK;
            Close();
            return;
        }
        if (_closeWhenDone)
        {
            DialogResult = DialogResult.Cancel;
            Close();
            return;
        }
        Show(_credentials, _signIn);
        _signIn.Enabled = true;
        _username.Enabled = true;
        _password.Enabled = true;
        _progress.Text = Result.Cancelled ? "" : Result.Message;
        _password.Focus();
    }

    private void CancelRun()
    {
        _waiting?.TrySetResult(null);
        _run?.Cancel();
    }

    private void Answer(object? value)
    {
        if (value is null) return;
        _waiting?.TrySetResult(value);
    }

    private void SetRecoveryMode(bool recovery)
    {
        _recoveryMode = recovery;
        _codeQuestion.Text = recovery
            ? "Type one of your recovery codes (each works once)."
            : "Type the 6-digit code from your authenticator app.";
        _codeBox.MaxLength = recovery ? 40 : 10;
        _codeBox.Text = "";
        _useRecovery.Text = recovery ? "Use the 6-digit code instead" : "Use a recovery code instead";
        _codeBox.Focus();
    }

    /// <summary>Shows a question on the window's thread and waits for the
    /// answer (null when cancelled).</summary>
    private Task<object?> Ask(Action show, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        ct.Register(() => tcs.TrySetResult(null));
        BeginInvoke(() =>
        {
            _waiting = tcs;
            show();
        });
        return tcs.Task;
    }

    // ── IConnectPrompts (called off the window's thread) ──

    public async Task<AccountChoice?> ChooseAccountAsync(IReadOnlyList<AccountChoice> accounts, CancellationToken ct)
    {
        var picked = await Ask(() =>
        {
            _choiceQuestion.Text = "This username and password work at more than one store. Which one?";
            _choiceList.Items.Clear();
            foreach (var a in accounts) _choiceList.Items.Add(a);
            _choiceList.SelectedIndex = 0;
            _progress.Text = "";
            Show(_choice, _choiceContinue);
        }, ct);
        return picked as AccountChoice;
    }

    public async Task<CodeEntry?> AskForCodeAsync(bool hasRecoveryCodes, string problem, CancellationToken ct)
    {
        var entry = await Ask(() =>
        {
            SetRecoveryMode(_recoveryMode && hasRecoveryCodes);
            _useRecovery.Visible = hasRecoveryCodes;
            _codeProblem.Text = problem;
            _progress.Text = "";
            Show(_code, _codeContinue);
            _codeBox.Focus();
        }, ct);
        return entry as CodeEntry;
    }

    public async Task<StoreChoice?> ChooseStoreAsync(IReadOnlyList<StoreChoice> stores, CancellationToken ct)
    {
        var picked = await Ask(() =>
        {
            _choiceQuestion.Text = "Which store is this computer at?";
            _choiceList.Items.Clear();
            foreach (var s in stores) _choiceList.Items.Add(s);
            var home = stores.ToList().FindIndex(s => s.IsHome);
            _choiceList.SelectedIndex = home >= 0 ? home : 0;
            _progress.Text = "";
            Show(_choice, _choiceContinue);
        }, ct);
        return picked as StoreChoice;
    }

    public void Progress(string message)
    {
        if (IsDisposed || !IsHandleCreated) return;
        BeginInvoke(() =>
        {
            if (!_closeWhenDone) _progress.Text = message;
            Show(_credentials, _signIn);
        });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _client.Dispose();
        base.Dispose(disposing);
    }
}
