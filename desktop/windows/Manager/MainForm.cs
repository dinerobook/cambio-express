using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.ServiceProcess;
using DineroBook.Processor;
using DineroBook.Processor.Connect;

namespace DineroBook.Manager;

/// <summary>
/// DineroBook Manager's window: Status (what the service is doing), Setup
/// (connect, Passport folder, the service) and Log. Status and Log work for
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
        "Service", "Store", "Now", "Last upload", "Sent today", "Waiting", "Waiting on", "Skipped", "Missed", "Last problem",
        "Passport folder", "DineroBook", "Updated",
    ];

    // Setup
    private readonly Label _account = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly Button _connect = new() { Text = "Connect…", AutoSize = true };
    private readonly Button _test = new() { Text = "Test connection", AutoSize = true };
    private readonly Label _testResult = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly TextBox _folder = new() { Width = 430, AccessibleName = "Passport folder" };
    private readonly Button _browse = new() { Text = "Browse…", AutoSize = true };
    private readonly Button _check = new() { Text = "Check", AutoSize = true };
    private readonly Label _folderResult = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly TextBox _api = new() { Width = 300, AccessibleName = "DineroBook address" };
    private readonly ToggleSwitch _deleteFromOutbox = new()
    {
        AutoSize = true,
        Text = "Delete files from XMLGateway once they are copied to this computer",
        Margin = new Padding(3, 8, 3, 0),
    };
    private readonly ToggleSwitch _deleteFromInbox = new()
    {
        AutoSize = true,
        Text = "Delete files from the temp folder once DineroBook has them",
        Margin = new Padding(3, 4, 3, 0),
    };
    private readonly Button _save = new() { Text = "Save settings", AutoSize = true };
    private readonly Label _serviceState = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly Button _install = new() { Text = "Install / Update", AutoSize = true };
    private readonly Button _start = new() { Text = "Start", AutoSize = true };
    private readonly Button _stop = new() { Text = "Stop", AutoSize = true };
    private readonly Button _restart = new() { Text = "Restart", AutoSize = true };
    private readonly Button _uninstall = new() { Text = "Uninstall", AutoSize = true };
    private readonly Label _serviceResult = new() { AutoSize = true, MaximumSize = new Size(620, 0) };
    private readonly Button _clearCache = new() { Text = "Clear cache", AutoSize = true };
    private readonly Label _cacheSize = new() { AutoSize = true, Margin = new Padding(3, 8, 3, 0) };
    private readonly Label _cacheResult = new() { AutoSize = true, MaximumSize = new Size(620, 0) };

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
            if (tabs.SelectedIndex == 1) ShowCacheSize();
            if (tabs.SelectedIndex == 2) LoadLogList();
        };
        Load += (_, _) =>
        {
            LoadSettingsIntoForm();
            ShowCacheSize();
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
                ? "Test folder: the key and settings are saved there. The service needs administrator rights."
                : "Viewing only. Connecting, settings and the service need administrator rights.",
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
        account.Controls.Add(Row(_connect, _test));
        account.Controls.Add(_testResult);

        var folder = Column();
        folder.Controls.Add(new Label { AutoSize = true, Text = "Passport's BOOutbox network share (a mapped drive letter is saved as its network path):" });
        folder.Controls.Add(Row(_folder, _browse, _check));
        folder.Controls.Add(_folderResult);
        folder.Controls.Add(Row(new Label { AutoSize = true, Text = "DineroBook address:", Margin = new Padding(3, 7, 3, 0) }, _api));
        folder.Controls.Add(_deleteFromOutbox);
        folder.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(620, 0),
            Margin = new Padding(20, 0, 3, 6),
            ForeColor = SystemColors.GrayText,
            Text = "Every file is copied to this computer the moment Passport finishes it, and sent from there. "
                   + "Leave this off while Modisoft or another back office reads the same folder: "
                   + "they would never see the files. Turn it on once DineroBook is the only program reading them.",
        });
        folder.Controls.Add(_deleteFromInbox);
        folder.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(620, 0),
            Margin = new Padding(20, 0, 3, 6),
            ForeColor = SystemColors.GrayText,
            Text = "The temp folder is this computer's own copy of each file (" + _paths.Inbox + "). "
                   + "On: a copy is deleted as soon as DineroBook has the file. "
                   + "Off: it is kept in " + _paths.Archive + ", one folder a day.",
        });
        folder.Controls.Add(_save);

        var service = Column();
        service.Controls.Add(_serviceState);
        service.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(620, 0),
            Margin = new Padding(3, 8, 3, 4),
            Text = "It runs as NetworkService and reads the BOOutbox share as this computer, like LdPosService: no Windows account or password to type.",
        });
        service.Controls.Add(Row(_install, _start, _stop, _restart, _uninstall));
        service.Controls.Add(_serviceResult);
        service.Controls.Add(new Label
        {
            AutoSize = true,
            MaximumSize = new Size(620, 0),
            Margin = new Padding(3, 12, 3, 4),
            Text = "Cache: the lists of files already copied and sent (sent.txt, skipped.txt, collected\\*.txt). "
                   + "They grow every day. Clearing them stops the service, deletes the lists and starts it again. "
                   + "Settings, the key, the logs, files still to send and the archive stay.",
        });
        service.Controls.Add(Row(_clearCache, _cacheSize));
        service.Controls.Add(_cacheResult);

        // Added bottom-up: Dock=Top stacks the last one added on top.
        page.Controls.Add(Group("3. Windows service", service));
        page.Controls.Add(Group("2. Passport folder", folder));
        page.Controls.Add(Group("1. Connect to DineroBook", account));

        _connect.Click += async (_, _) => await ConnectAsync();
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
        _clearCache.Click += async (_, _) => await ClearCacheAsync();
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
        _deleteFromOutbox.Checked = settings.DeleteFromOutbox;
        _deleteFromInbox.Checked = settings.DeleteFromInbox;
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
                ? $" — connected with a code from {settings.ConnectedBy}" + (settings.ConnectedAt is { } at ? $" on {at.LocalDateTime:d}" : "")
                : "")
            : "Not connected — Setup → Connect");
        Set("Passport folder", settings.WatchFolder + (settings.DeleteFromOutbox
            ? " — each file is deleted there once it is copied"
            : " — files are copied, never changed there"));
        Set("DineroBook", settings.ApiUrl);

        if (status is null)
        {
            Set("Now", running ? "Starting…" : "—");
            foreach (var k in new[] { "Last upload", "Sent today", "Waiting", "Waiting on", "Skipped", "Missed", "Last problem", "Updated" }) Set(k, "—");
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
            Set("Missed", status.MissedTotal == 0
                ? "0"
                : $"{status.MissedTotal:N0} left the Passport folder before they could be copied (another program took them first)");
            Set("Last problem", status.LastError.Length > 0
                ? $"{status.LastError} ({status.LastErrorAt?.LocalDateTime:g})"
                : "None");
            Set("Updated", status.UpdatedAt.LocalDateTime.ToString("G", CultureInfo.CurrentCulture)
                           + (status.Version.Length > 0 ? $" · Processor {status.Version}" : ""));
        }

        _account.Text = settings.StoreName.Length > 0
            ? $"This computer sends {settings.StoreName}'s register files" +
              (settings.KeyLabel.Length > 0 ? $" (key “{settings.KeyLabel}”)." : ".")
            : "Not connected yet. On DineroBook, open Register import → Automatic uploads → Connect a computer, then choose Connect here and scan the code.";
        _connect.Text = settings.StoreName.Length > 0 ? "Connect again…" : "Connect…";
        _serviceState.Text = !service.Installed
            ? "Not installed on this computer."
            : $"{service.Describe()}. Runs as {service.Account}. Program: {service.ImagePath}" +
              (service.NeedsNewAccount ? $"\nInstalled by an older DineroBook Manager: choose Install / Update to run it as {ServiceControl.Account}." : "");
        UpdateEnabled(service);
    }

    private void Set(string row, string text) => _values[row].Text = text;

    private void UpdateEnabled(ServiceControl.Info? info = null)
    {
        info ??= SafeQuery();
        var admin = Elevation.IsElevated;
        var canWrite = _setup.CanWrite;
        _connect.Enabled = canWrite && !_busy;
        _save.Enabled = canWrite && !_busy;
        _deleteFromOutbox.Enabled = canWrite && !_busy;
        _deleteFromInbox.Enabled = canWrite && !_busy;
        _test.Enabled = !_busy;
        _install.Enabled = admin && !_busy;
        _start.Enabled = admin && !_busy && info.Installed && info.Status != ServiceControllerStatus.Running;
        _stop.Enabled = admin && !_busy && info.Installed && info.Status == ServiceControllerStatus.Running;
        _restart.Enabled = admin && !_busy && info.Installed;
        _uninstall.Enabled = admin && !_busy && info.Installed;
        // The machine's own lists sit beside a running service: only an
        // administrator may stop it to clear them. A test folder needs no service.
        _clearCache.Enabled = (_paths.IsCustom || admin) && !_busy;
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

    private async Task ConnectAsync()
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
        // Sent along so DineroBook revokes the key this computer had.
        string? previous = null;
        try
        {
            previous = _setup.LoadKey();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
        {
        }
        await Busy(async () =>
        {
            using var dialog = new ConnectForm(api, _setup, previous);
            if (dialog.ShowDialog(this) == DialogResult.OK && dialog.Result is { Ok: true } result)
            {
                var service = SafeQuery();
                var next = service.Installed
                    ? "\n\nThe service picks up the new key within a few seconds."
                    : "\n\nNext: Install / Update the service below.";
                _testResult.Text = "";
                MessageBox.Show(this, result.Message + next, Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
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
                        lines.Add("✖ The saved key cannot be read: " + ex.Message + " Connect again.");
                    }
                    if (key is null && lines.Count == 1)
                    {
                        lines.Add("Not connected yet.");
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
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var chosen = ServiceFolder.Resolve(dialog.SelectedPath, new WindowsDriveMap());
        _folder.Text = chosen.Path;
        _folderResult.Text = chosen.Ok ? chosen.Note : "✖ " + chosen.Problem;
    }

    private async Task<FolderCheck.Result> CheckFolderAsync()
    {
        var chosen = ServiceFolder.Resolve(_folder.Text, new WindowsDriveMap());
        if (!chosen.Ok)
        {
            _folderResult.Text = "✖ " + chosen.Problem;
            return new FolderCheck.Result(false, chosen.Problem, 0);
        }
        _folder.Text = chosen.Path;
        _folderResult.Text = "Checking…";
        var result = await Task.Run(() => FolderCheck.Check(chosen.Path));
        _folderResult.Text = (result.Ok ? "✔ " : "✖ ") + result.Message +
                             (chosen.Note.Length > 0 ? "\n" + chosen.Note : "") +
                             (ServiceFolder.IsShare(chosen.Path)
                                 ? "\nThis checks with your Windows login; the service reads the share as this computer (NetworkService)."
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
            var chosen = ServiceFolder.Resolve(_folder.Text, new WindowsDriveMap());
            if (!chosen.Ok)
            {
                MessageBox.Show(this, chosen.Problem, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            var check = await CheckFolderAsync();
            if (!check.Ok && MessageBox.Show(this, check.Message + "\n\nSave this folder anyway?", Text,
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
            {
                return;
            }
            var settings = _setup.LoadSettings();
            var apiText = api.ToString().TrimEnd('/');
            var apiChanged = !string.Equals(settings.ApiUrl.TrimEnd('/'), apiText, StringComparison.OrdinalIgnoreCase);
            if (_deleteFromOutbox.Checked && !settings.DeleteFromOutbox
                && MessageBox.Show(this,
                    "Each file will be deleted from the Passport folder once it is copied to this computer.\n\n"
                    + "Modisoft or any other back office reading the same folder will stop seeing the files. "
                    + "Only do this when DineroBook is the only program reading them.\n\nDelete files from XMLGateway?",
                    Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            {
                _deleteFromOutbox.Checked = false;
                return;
            }
            settings.WatchFolder = _folder.Text.Trim();
            settings.ApiUrl = apiText;
            settings.DeleteFromOutbox = _deleteFromOutbox.Checked;
            settings.DeleteFromInbox = _deleteFromInbox.Checked;
            try
            {
                _setup.SaveSettings(settings);
                _api.Text = apiText;
                MessageBox.Show(this,
                    "Saved. The service uses the new settings within a few seconds." +
                    (apiChanged && settings.StoreId is not null ? "\n\nThe DineroBook address changed: connect again so the key matches it." : ""),
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                MessageBox.Show(this, "Could not save: " + ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        });
    }

    private async Task InstallAsync()
    {
        var source = Path.Combine(AppContext.BaseDirectory, ServiceControl.ProcessorExe);
        await Busy(async () =>
        {
            _serviceResult.Text = "Installing…";
            try
            {
                await Task.Run(() =>
                {
                    ServiceControl.InstallOrUpdate(source);
                    _setup.SecureFolder();
                    ServiceControl.Start();
                });
                _serviceResult.Text = $"Installed and started as {ServiceControl.Account}. It starts by itself with Windows.";
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

    private void ShowCacheSize()
    {
        try
        {
            _cacheSize.Text = "Now: " + StateCache.Measure(_paths).Describe();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _cacheSize.Text = "";
        }
    }

    private async Task ClearCacheAsync()
    {
        await Task.Yield();
        if (MessageBox.Show(this,
                "Clear the cache?\n\n"
                + "The lists of files already copied and sent are deleted"
                + (_paths.IsCustom ? "" : " (the service is stopped meanwhile and started again)") + ". "
                + "A file still in the Passport folder or the temp folder is sent once more; "
                + "DineroBook answers \"duplicate\" for the ones it already has, so nothing is counted twice.",
                Text, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
        {
            return;
        }
        await Busy(async () =>
        {
            _cacheResult.Text = "Clearing…";
            try
            {
                var cleared = await Task.Run(() =>
                {
                    // A test folder has no service of its own.
                    var info = _paths.IsCustom ? new ServiceControl.Info(false, null, "", "") : ServiceControl.Query();
                    var wasRunning = info.Installed && info.Status is ServiceControllerStatus.Running or ServiceControllerStatus.StartPending;
                    if (info.Installed) ServiceControl.Stop();
                    try
                    {
                        return StateCache.Clear(_paths);
                    }
                    finally
                    {
                        if (wasRunning) ServiceControl.Start();
                    }
                });
                _cacheResult.Text = cleared.Files == 0
                    ? "The cache was already empty."
                    : $"Cleared {cleared.Describe()}.";
            }
            catch (Exception ex)
            {
                _cacheResult.Text = "✖ " + Explain(ex);
            }
            ShowCacheSize();
        });
    }

    private static string Explain(Exception ex) => ex switch
    {
        // ERROR_SERVICE_LOGON_FAILED
        InvalidOperationException { InnerException: Win32Exception { NativeErrorCode: 1069 } } =>
            $"Windows could not start the service as {ServiceControl.Account}.",
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
