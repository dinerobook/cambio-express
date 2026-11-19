using DineroBook.Processor;
using DineroBook.Processor.Connect;

namespace DineroBook.Manager;

/// <summary>
/// "Connect": one box for the connect code. Someone makes the code on
/// DineroBook (Register import → Automatic uploads → Connect a computer);
/// here it is scanned with the barcode scanner, which types it and presses
/// Enter, or typed by hand. Nobody types a name or a password (owner,
/// 2026-11-19). Only the store's agent key is kept.
/// </summary>
internal sealed class ConnectForm : Form
{
    // Shared across tries: the server allows 10 a minute per address.
    private static readonly RateWindow Guard = new(8, TimeSpan.FromMinutes(1));

    private readonly Uri _api;
    private readonly MachineSetup _setup;
    private readonly string? _previousKey;

    private readonly TextBox _code = new()
    {
        Width = 300, MaxLength = 40, CharacterCasing = CharacterCasing.Upper,
        Font = new Font("Consolas", 16f), AccessibleName = "Connect code",
        PlaceholderText = "XXXX-XXXX-XXXX",
    };
    private readonly Button _connect = new() { Text = "Connect", AutoSize = true, Enabled = false };
    private readonly Button _cancel = new() { Text = "Cancel", AutoSize = true };
    private readonly Label _progress = new() { AutoSize = true, MaximumSize = new Size(420, 0), Margin = new Padding(0, 10, 0, 0) };

    private CancellationTokenSource? _run;

    public ConnectResult? Result { get; private set; }

    public ConnectForm(Uri api, MachineSetup setup, string? previousKey)
    {
        _api = api;
        _setup = setup;
        _previousKey = previousKey;

        Text = "Connect to DineroBook";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(460, 270);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.75f);

        var col = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false,
            Padding = new Padding(16, 12, 16, 0),
        };
        col.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(420, 0),
            Text = $"On DineroBook ({api.Host}), open Register import → Automatic uploads and choose " +
                   "Connect a computer. Scan the barcode it shows, or type the code here.",
        });
        col.Controls.Add(new Label { AutoSize = true, Text = "Connect code", Margin = new Padding(0, 14, 0, 0) });
        col.Controls.Add(_code);
        _connect.Margin = new Padding(0, 10, 0, 0);
        col.Controls.Add(_connect);
        col.Controls.Add(_progress);

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, Height = 44, Padding = new Padding(8) };
        bottom.Controls.Add(_cancel);
        Controls.Add(col);
        Controls.Add(bottom);
        AcceptButton = _connect;
        CancelButton = _cancel;

        _code.TextChanged += (_, _) => _connect.Enabled = _run is null && ConnectCode.IsComplete(_code.Text);
        // A barcode scanner types the code and presses Enter: AcceptButton.
        _connect.Click += async (_, _) => await ConnectAsync();
        _cancel.Click += (_, _) => Close();
        FormClosing += (_, _) => _run?.Cancel();
        Shown += (_, _) => _code.Focus();
    }

    private async Task ConnectAsync()
    {
        if (_run is not null || !ConnectCode.IsComplete(_code.Text)) return;
        _run = new CancellationTokenSource();
        _connect.Enabled = false;
        _code.Enabled = false;
        _progress.ForeColor = SystemColors.ControlText;
        _progress.Text = "Connecting…";
        try
        {
            using var http = Http.Create(Http.UserAgent("dinerobook-manager"), TimeSpan.FromSeconds(30));
            var client = new ConnectClient(http, _api, Guard);
            Result = await client.ConnectAsync(_code.Text, ConnectClient.KeyLabel(Environment.MachineName),
                _previousKey, _setup.Sink(), _run.Token);
            if (Result.Ok)
            {
                DialogResult = DialogResult.OK;
                Close();
                return;
            }
            _progress.ForeColor = Color.Firebrick;
            _progress.Text = Result.Message;
            _code.SelectAll();
        }
        catch (OperationCanceledException)
        {
            // The dialog was closed.
        }
        finally
        {
            _run?.Dispose();
            _run = null;
            if (!IsDisposed)
            {
                _code.Enabled = true;
                _connect.Enabled = ConnectCode.IsComplete(_code.Text);
                _code.Focus();
            }
        }
    }
}
