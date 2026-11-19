using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.ServiceProcess;
using DineroBook.Processor;
using DineroBook.Processor.SignIn;

namespace DineroBook.Manager;

/// <summary>
/// DineroBook Manager's window: Status (what the service is doing), Setup
/// (sign in, Passport folder, the service) and Log. Status and Log work for
/// anyone; Setup asks Windows for administrator rights.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly DataPaths _paths;
    private readonly IReadOnlyList<string> _args;
    private readonly MachineSetup _setup;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 3000 };

    // Banner
    private readonly Panel _banner = new() { Dock = DockStyle.Top, Height = 44, BackColor = SystemColors.Info, Padding = new Padding(10, 8, 10, 8) };
    private readonly Button _elevate = new() { Text = "Restart as administrator", AutoSize = true, Dock = DockStyle.Right };

    // Status
    private readonly Dictionary<string, Label> _values = new();
    private static readonly string[] StatusRows =
    [
        "Service", "Store", "Now", "Last upload", "Sent today", "Waiting", "Waiting on", "Skipped", "Last problem",
        "Passport folder", "DineroBook", "Updated",
    ];

    // Setup
    private readonly Label _account = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly Button _signIn = new() { Text = "Sign in…", AutoSize = true };
    private readonly Button _test = new() { Text = "Test connection", AutoSize = true };
    private readonly Label _testResult = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly TextBox _folder = new() { Width = 430, AccessibleName = "Passport folder" };
    private readonly Button _browse = new() { Text = "Browse…", AutoSize = true };
    private readonly Button _check = new() { Text = "Check", AutoSize = true };
    private readonly Label _folderResult = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly TextBox _api = new() { Width = 300, AccessibleName = "DineroBook address" };
    private readonly Button _save = new() { Text = "Save settings", AutoSize = true };
    private readonly Label _serviceState = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly RadioButton _runLocal = new() { AutoSize = true, Text = "Local Service — the Passport folder is on this computer", Checked = true };
    private readonly RadioButton _runAccount = new() { AutoSize = true, Text = "A Windows account that can open the network share:" };
    private readonly TextBox _accountName = new() { Width = 220, PlaceholderText = @".\dinerobook or STORE\dinerobook", AccessibleName = "Windows account" };
    private readonly TextBox _accountPassword = new() { Width = 180, UseSystemPasswordChar = true, PlaceholderText = "its Windows password", AccessibleName = "Windows account password" };
    private readonly Button _install = new() { Text = "Install / Update", AutoSize = true };
    private readonly Button _start = new() { Text = "Start", AutoSize = true };
    private readonly Button _stop = new() { Text = "Stop", AutoSize = true };
    private readonly Button _restart = new() { Text = "Restart", AutoSize = true };
    private readonly Button _uninstall = new() { Text = "Uninstall", AutoSize = true };
    private readonly Label _serviceResult = new() { AutoSize = true, MaximumSize = new Size(620, 0) };

    // Log
    private readonly ComboBox _logFiles = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 260 };
    private readonly TextBox _logText = new()
    {
        Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Dock = DockStyle.Fill,
        Font = new Font("Consolas", 9f), BackColor = SystemColors.Window,
    };

    private bool _busy;

    public MainForm(DataPaths paths, IReadOnlyList<string> args)
    {
        _paths = paths;
        _args = args;
        _setup = new MachineSetup(paths);

        Text = "DineroBook Manager" + (paths.IsCustom ? $" — test folder {paths.Root}" : "");
        ClientSize = new Size(720, 560);
        MinimumSize = new Size(640, 480);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.75f);

        var tabs = new TabControl { Dock = DockStyle.Fill };
        tabs.TabPages.Add(BuildStatus());
        tabs.TabPages.Add(BuildSetup());
        tabs.TabPages.Add(BuildLog());
        Controls.Add(tabs);
        BuildBanner();
        Controls.Add(_banner);

        _timer.Tick += (_, _) => RefreshStatus();
        tabs.SelectedIndexChanged += (_, _) =>
        {
            if (tabs.SelectedIndex == 2) LoadLogList();
        };
        Load += (_, _) =>
        {
            LoadSettingsIntoForm();
            RefreshStatus();
            _timer.Start();
        };
    }

    // ── Layout ──

    private void BuildBanner()
    {
        var text = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleLeft,
            Text = _paths.IsCustom
                ? "Test folder: sign-in and settings are saved there. The service needs administrator rights."
                : "Viewing only. Signing in, settings and the service need administrator rights.",
        };
        _banner.Controls.Add(text);
        _banner.Controls.Add(_elevate);
        _banner.Visible = !Elevation.IsElevated;
        _elevate.Click += async (_, _) =>
        {
            await Task.Yield(); // Windows' prompt waits for an answer
            if (Elevation.RestartElevated(_args)) Close();
        };
    }

    private TabPage BuildStatus()
    {
        var page = new TabPage("Status") { Padding = new Padding(12) };
        var grid = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (var row in StatusRows)
        {
            grid.Controls.Add(new Label { Text = row, AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(3, 6, 3, 6) });
            var value = new Label { AutoSize = true, MaximumSize = new Size(520, 0), Margin = new Padding(3, 6, 3, 6), Text = "—" };
            _values[row] = value;
            grid.Controls.Add(value);
        }
        page.Controls.Add(grid);
        return page;
    }

    private static GroupBox Group(string title, Control content) =>
        new()
        {
            Text = title,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Dock = DockStyle.Top,
            Padding = new Padding(10, 6, 10, 10),
            Controls = { content },
        };

    private static FlowLayoutPanel Column() => new()
    {
        AutoSize = true,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        Dock = DockStyle.Fill,
    };

    private static FlowLayoutPanel Row(params Control[] controls)
    {
        var row = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false, Margin = new Padding(0) };
        row.Controls.AddRange(controls);
        return row;
    }

    private TabPage BuildSetup()
    {
        var page = new TabPage("Setup") { Padding = new Padding(8), AutoScroll = true };

        var account = Column();
        account.Controls.Add(_account);
        account.Controls.Add(Row(_signIn, _test));
        account.Controls.Add(_testResult);

        var folder = Column();
        folder.Controls.Add(new Label { AutoSize = true, Text = "The folder Passport writes its XML files to (BOOutbox):" });
        folder.Controls.Add(Row(_folder, _browse, _check));
        folder.Controls.Add(_folderResult);
        folder.Controls.Add(Row(new Label { AutoSize = true, Text = "DineroBook address:", Margin = new Padding(3, 7, 3, 0) }, _api));
        folder.Controls.Add(_save);

        var service = Column();
        service.Controls.Add(_serviceState);
        service.Controls.Add(new Label { AutoSize = true, Text = "Run the service as:", Margin = new Padding(3, 8, 3, 0) });
        service.Controls.Add(_runLocal);
        service.Controls.Add(_runAccount);
        service.Controls.Add(Row(_accountName, _accountPassword));
        service.Controls.Add(Row(_install, _start, _stop, _restart, _uninstall));
        service.Controls.Add(_serviceResult);

        // Added bottom-up: Dock=Top stacks the last one added on top.
        page.Controls.Add(Group("3. Windows service", service));
        page.Controls.Add(Group("2. Passport folder", folder));
        page.Controls.Add(Group("1. DineroBook account", account));

        _signIn.Click += async (_, _) => await SignInAsync();
        _test.Click += async (_, _) => await TestConnectionAsync();
        _browse.Click += async (_, _) =>
        {
            await Task.Yield();
            Browse();
        };
        _check.Click += async (_, _) => await CheckFolderAsync();
        _save.Click += async (_, _) => await SaveSettingsAsync();
        _install.Click += async (_, _) => await InstallAsync();
        _start.Click += async (_, _) => await ServiceActionAsync("Starting…", ServiceControl.Start, "Started.");
        _stop.Click += async (_, _) => await ServiceActionAsync("Stopping…", ServiceControl.Stop, "Stopped.");
        _restart.Click += async (_, _) => await ServiceActionAsync("Restarting…", ServiceControl.Restart, "Restarted.");
        _uninstall.Click += async (_, _) => await UninstallAsync();
        _runLocal.CheckedChanged += (_, _) => UpdateEnabled();
        return page;
    }

    private TabPage BuildLog()
    {
        var page = new TabPage("Log") { Padding = new Padding(8) };
        var refresh = new Button { Text = "Refresh", AutoSize = true };
        var open = new Button { Text = "Open log folder", AutoSize = true };
        var bar = Row(_logFiles, refresh, open);
        bar.Dock = DockStyle.Top;
        page.Controls.Add(_logText);
        page.Controls.Add(bar);
        refresh.Click += (_, _) => ShowLog();
        _logFiles.SelectedIndexChanged += (_, _) => ShowLog();
        open.Click += (_, _) =>
        {
            Directory.CreateDirectory(_paths.Logs);
            Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { _paths.Logs }, UseShellExecute = false });
        };
        return page;
    }

    // ── Status ──

    private void LoadSettingsIntoForm()
    {
        var settings = _setup.LoadSettings();
        _folder.Text = settings.WatchFolder;
        _api.Text = settings.ApiUrl;
        var account = ServiceControl.CurrentAccount();
        _runLocal.Checked = account.IsLocalService;
        _runAccount.Checked = !account.IsLocalService;
        if (!account.IsLocalService) _accountName.Text = account.Name;
        UpdateEnabled();
    }

    private void RefreshStatus()
    {
        var settings = _setup.LoadSettings();
        var status = ProcessorStatus.TryRead(_paths.Status);
        ServiceControl.Info service;
        try
        {
            service = ServiceControl.Query();
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            service = new ServiceControl.Info(false, null, "", "");
        }

        var running = service.Status == ServiceControllerStatus.Running;
        Set("Service", service.Installed
            ? service.Describe() + (service.Account.Length > 0 ? $" (runs as {service.Account})" : "")
            : "Not installed — Setup → Install / Update");
        Set("Store", settings.StoreName.Length > 0
            ? settings.StoreName + (settings.ConnectedBy.Length > 0
                ? $" — signed in by {settings.ConnectedBy}" + (settings.ConnectedAt is { } at ? $" on {at.LocalDateTime:d}" : "")
                : "")
            : "Not signed in — Setup → Sign in");
        Set("Passport folder", settings.WatchFolder);
        Set("DineroBook", settings.ApiUrl);

        if (status is null)
        {
            Set("Now", running ? "Starting…" : "—");
            foreach (var k in new[] { "Last upload", "Sent today", "Waiting", "Waiting on", "Skipped", "Last problem", "Updated" }) Set(k, "—");
        }
        else
        {
            var stale = running && DateTimeOffset.UtcNow - status.UpdatedAt > TimeSpan.FromMinutes(2);
            Set("Now", (!running && service.Installed ? "The service is not running. " : "")
                       + (stale ? "(not updated for a while) " : "") + status.Message);
            Set("Last upload", status.LastUploadAt is { } lu
                ? $"{status.LastUploadFile} at {lu.LocalDateTime:g} ({status.LastUploadResult})"
                : "None yet");
            Set("Sent today", status.TodayCount.ToString("N0", CultureInfo.CurrentCulture));
            Set("Waiting", status.Waiting.ToString("N0", CultureInfo.CurrentCulture)
                           + (status.Uploading > 0 ? $" ({status.Uploading} being sent now)" : ""));
            // Files of later business days wait for this one (the server
            // books a day as soon as a later day's file arrives).
            Set("Waiting on", status.WaitingOn.Length > 0
                ? status.WaitingOn + " — files of later business days wait for it"
                : "Nothing");
            Set("Skipped", status.SkippedTotal == 0
                ? "0"
                : $"{status.SkippedTotal:N0} refused for good by DineroBook (see the Log)");
            Set("Last problem", status.LastError.Length > 0
                ? $"{status.LastError} ({status.LastErrorAt?.LocalDateTime:g})"
                : "None");
            Set("Updated", status.UpdatedAt.LocalDateTime.ToString("G", CultureInfo.CurrentCulture)
                           + (status.Version.Length > 0 ? $" · Processor {status.Version}" : ""));
        }

        _account.Text = settings.StoreName.Length > 0
            ? $"This computer sends {settings.StoreName}'s register files" +
              (settings.KeyLabel.Length > 0 ? $" (key “{settings.KeyLabel}”)." : ".")
            : "Not signed in yet. Sign in with the store's DineroBook admin or owner login.";
        _signIn.Text = settings.StoreName.Length > 0 ? "Sign in again…" : "Sign in…";
        _serviceState.Text = service.Installed
            ? $"{service.Describe()}. Runs as {service.Account}. Program: {service.ImagePath}"
            : "Not installed on this computer.";
        UpdateEnabled(service);
    }

    private void Set(string row, string text) => _values[row].Text = text;

    private void UpdateEnabled(ServiceControl.Info? info = null)
    {
        info ??= SafeQuery();
        var admin = Elevation.IsElevated;
        var canWrite = _setup.CanWrite;
        _signIn.Enabled = canWrite && !_busy;
        _save.Enabled = canWrite && !_busy;
        _test.Enabled = !_busy;
        _accountName.Enabled = _runAccount.Checked;
        _accountPassword.Enabled = _runAccount.Checked;
        _install.Enabled = admin && !_busy;
        _start.Enabled = admin && !_busy && info.Installed && info.Status != ServiceControllerStatus.Running;
        _stop.Enabled = admin && !_busy && info.Installed && info.Status == ServiceControllerStatus.Running;
        _restart.Enabled = admin && !_busy && info.Installed;
        _uninstall.Enabled = admin && !_busy && info.Installed;
    }

    private static ServiceControl.Info SafeQuery()
    {
        try
        {
            return ServiceControl.Query();
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            return new ServiceControl.Info(false, null, "", "");
        }
    }

    // ── Setup actions ──

    private async Task Busy(Func<Task> work)
    {
        if (_busy) return;
        _busy = true;
        UseWaitCursor = true;
        UpdateEnabled();
        try
        {
            await work();
        }
        finally
        {
            _busy = false;
            UseWaitCursor = false;
            RefreshStatus();
        }
    }

    // Each click that opens a dialog first yields to the message loop: a
    // dialog opened inside the click itself would also run inside a
    // screen reader's UI Automation call, and the window would stop
    // answering it until the dialog closed.

    private async Task SignInAsync()
    {
        await Task.Yield();
        var settings = _setup.LoadSettings();
        if (!ApiAddress.TryParse(settings.ApiUrl, out var api, out var error))
        {
            MessageBox.Show(this, "Fix the DineroBook address first: " + error, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (!string.Equals(_api.Text.Trim().TrimEnd('/'), settings.ApiUrl.TrimEnd('/'), StringComparison.OrdinalIgnoreCase))
        {
            MessageBox.Show(this, "Save the settings first, so the key is made for the address shown.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        var previous = settings.KeyId is { } id ? new PreviousKey(id, settings.StoreId) : null;
        await Busy(async () =>
        {
            using var dialog = new SignInForm(api, _setup, previous);
            if (dialog.ShowDialog(this) == DialogResult.OK && dialog.Result is { Ok: true } result)
            {
                var notes = result.Notes.Count > 0 ? "\n\n" + string.Join("\n", result.Notes) : "";
                var service = SafeQuery();
                var next = service.Installed
                    ? "\n\nThe service picks up the new key within a few seconds."
                    : "\n\nNext: Install / Update the service below.";
                _testResult.Text = "";
                MessageBox.Show(this, result.Message + notes + next, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            await Task.CompletedTask;
        });
    }

    private async Task TestConnectionAsync()
    {
        if (!ApiAddress.TryParse(_api.Text, out var api, out var error))
        {
            _testResult.Text = error;
            return;
        }
        await Busy(async () =>
        {
            _testResult.Text = "Testing…";
            using var http = Http.Create(Http.UserAgent("dinerobook-manager"), TimeSpan.FromSeconds(20));
            var lines = new List<string>();
            var reach = await ConnectionCheck.ReachableAsync(http, api, CancellationToken.None);
            lines.Add((reach.Ok ? "✔ " : "✖ ") + reach.Message);
            if (reach.Ok)
            {
                if (!_setup.CanWrite)
                {
                    lines.Add("Restart as administrator to also test this computer's key.");
                }
                else
                {
                    string? key = null;
                    try
                    {
                        key = _setup.LoadKey();
                    }
                    catch (Exception ex)
                    {
                        lines.Add("✖ The saved key cannot be read: " + ex.Message + " Sign in again.");
                    }
                    if (key is null && lines.Count == 1)
                    {
                        lines.Add("Not signed in yet.");
                    }
                    else if (key is not null)
                    {
                        var check = await ConnectionCheck.KeyAsync(http, api, key, CancellationToken.None);
                        lines.Add((check.Ok ? "✔ " : "✖ ") + check.Message);
                    }
                }
            }
            _testResult.Text = string.Join("\n", lines);
        });
    }

    private void Browse()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "The folder Passport writes its XML files to (BOOutbox)",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
        };
        if (Directory.Exists(_folder.Text)) dialog.InitialDirectory = _folder.Text;
        if (dialog.ShowDialog(this) == DialogResult.OK) _folder.Text = dialog.SelectedPath;
    }

    private async Task<FolderCheck.Result> CheckFolderAsync()
    {
        var path = _folder.Text;
        _folderResult.Text = "Checking…";
        var result = await Task.Run(() => FolderCheck.Check(path));
        _folderResult.Text = (result.Ok ? "✔ " : "✖ ") + result.Message +
                             (path.StartsWith(@"\\", StringComparison.Ordinal)
                                 ? "\nThis checks with your Windows login. The service reads the share with its own account (Setup → Windows service)."
                                 : "");
        return result;
    }

    private async Task SaveSettingsAsync()
    {
        await Task.Yield();
        if (!ApiAddress.TryParse(_api.Text, out var api, out var error))
        {
            MessageBox.Show(this, error, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        await Busy(async () =>
        {
            var check = await CheckFolderAsync();
            if (!check.Ok && MessageBox.Show(this, check.Message + "\n\nSave this folder anyway?", Text,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
            {
                return;
            }
            var settings = _setup.LoadSettings();
            var apiText = api.ToString().TrimEnd('/');
            var apiChanged = !string.Equals(settings.ApiUrl.TrimEnd('/'), apiText, StringComparison.OrdinalIgnoreCase);
            settings.WatchFolder = _folder.Text.Trim();
            settings.ApiUrl = apiText;
            try
            {
                _setup.SaveSettings(settings);
                _api.Text = apiText;
                MessageBox.Show(this,
                    "Saved. The service uses the new settings within a few seconds." +
                    (apiChanged && settings.StoreId is not null ? "\n\nThe DineroBook address changed: sign in again so the key matches it." : ""),
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                MessageBox.Show(this, "Could not save: " + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        });
    }

    /// <summary>The account chosen on the form, or null to keep the
    /// service's current one.</summary>
    private ServiceAccount? ChosenAccount(out string problem)
    {
        problem = "";
        if (_runLocal.Checked) return ServiceAccount.LocalService;
        var name = _accountName.Text.Trim();
        if (name.Length == 0)
        {
            problem = @"Type the Windows account, like .\dinerobook or STORE\dinerobook.";
            return null;
        }
        var current = ServiceControl.CurrentAccount();
        if (_accountPassword.Text.Length == 0)
        {
            if (!current.IsLocalService && string.Equals(ServiceAccount.Windows(name, "").Name, current.Name, StringComparison.OrdinalIgnoreCase))
            {
                return null; // unchanged
            }
            problem = "Type the account's Windows password (it goes to Windows only; DineroBook Manager does not keep it).";
            return null;
        }
        return ServiceAccount.Windows(name, _accountPassword.Text);
    }

    private async Task InstallAsync()
    {
        var account = ChosenAccount(out var problem);
        if (problem.Length > 0)
        {
            _serviceResult.Text = problem;
            return;
        }
        var source = Path.Combine(AppContext.BaseDirectory, ServiceControl.ProcessorExe);
        await Busy(async () =>
        {
            _serviceResult.Text = "Installing…";
            try
            {
                await Task.Run(() =>
                {
                    ServiceControl.InstallOrUpdate(source, account);
                    _setup.SecureFolder();
                    ServiceControl.Start();
                });
                _accountPassword.Text = "";
                _serviceResult.Text = "Installed and started. It starts by itself with Windows.";
            }
            catch (Exception ex)
            {
                _serviceResult.Text = "✖ " + Explain(ex);
            }
        });
    }

    private async Task ServiceActionAsync(string doing, Action action, string done)
    {
        await Busy(async () =>
        {
            _serviceResult.Text = doing;
            try
            {
                await Task.Run(action);
                _serviceResult.Text = done;
            }
            catch (Exception ex)
            {
                _serviceResult.Text = "✖ " + Explain(ex);
            }
        });
    }

    private async Task UninstallAsync()
    {
        await Task.Yield();
        if (MessageBox.Show(this, "Remove the DineroBook Processor service from this computer? Register files stop going to DineroBook.",
                Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
        {
            return;
        }
        var forgetKey = File.Exists(_paths.AgentKey) && MessageBox.Show(this,
            "Also delete the saved upload key from this computer?\n\nRevoke it in DineroBook too: Register import → Automatic uploads.",
            Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;
        await Busy(async () =>
        {
            _serviceResult.Text = "Removing…";
            try
            {
                await Task.Run(ServiceControl.Uninstall);
                if (forgetKey) _setup.ForgetKey();
                _serviceResult.Text = "Removed. The data folder (" + _paths.Root + ") was left in place.";
            }
            catch (Exception ex)
            {
                _serviceResult.Text = "✖ " + Explain(ex);
            }
        });
    }

    private static string Explain(Exception ex) => ex switch
    {
        // ERROR_SERVICE_LOGON_FAILED
        InvalidOperationException { InnerException: Win32Exception { NativeErrorCode: 1069 } } =>
            "Windows could not log the service on: check the account's password.",
        System.ServiceProcess.TimeoutException =>
            "The service did not answer in time. Look at the Log tab and the Windows Event Log (Application).",
        _ => ex.Message + (ex.InnerException is { } inner ? " " + inner.Message : ""),
    };

    // ── Log ──

    private void LoadLogList()
    {
        var selected = _logFiles.SelectedItem as string;
        _logFiles.Items.Clear();
        try
        {
            if (Directory.Exists(_paths.Logs))
            {
                foreach (var f in Directory.GetFiles(_paths.Logs, "processor-*.log").Select(f => Path.GetFileName(f)).OrderDescending())
                {
                    _logFiles.Items.Add(f);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logText.Text = "Cannot list the logs: " + ex.Message;
            return;
        }
        if (_logFiles.Items.Count == 0)
        {
            _logText.Text = "No log yet. The service writes one here once it runs: " + _paths.Logs;
            return;
        }
        _logFiles.SelectedItem = selected is not null && _logFiles.Items.Contains(selected) ? selected : _logFiles.Items[0];
    }

    private void ShowLog()
    {
        if (_logFiles.SelectedItem is not string name) return;
        try
        {
            var text = AtomicFile.TryReadShared(Path.Combine(_paths.Logs, name)) ?? "";
            var lines = text.Split('\n');
            var tail = lines.Length > 2000 ? lines[^2000..] : lines;
            _logText.Text = string.Join("\n", tail).Replace("\r", "").Replace("\n", Environment.NewLine);
            _logText.SelectionStart = _logText.TextLength;
            _logText.ScrollToCaret();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logText.Text = "Cannot read the log: " + ex.Message;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _timer.Dispose();
        base.Dispose(disposing);
    }
}
