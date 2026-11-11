using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DineroBook.CheckDesk;

/// <summary>
/// The whole window is DineroBook's check cashing app (it opens on Cash
/// a check). The page reaches the scanner through WebView2 messages
/// (ScannerBridge); only DineroBook pages may send them, and any other
/// site opens in the computer's normal browser. Sign-in and the
/// computer's activation live in this window's own browser data, so
/// they stay after a restart.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly AppSettings _settings;
    private readonly ScannerBridge _bridge;
    private readonly string _dataFolder;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };

    public MainForm(AppSettings settings, IScanner scanner, string dataFolder)
    {
        _settings = settings;
        _bridge = new ScannerBridge(scanner);
        _dataFolder = dataFolder;
        Text = "DineroBook Check Desk";
        MinimumSize = new Size(1024, 700);
        WindowState = FormWindowState.Maximized;
        Controls.Add(_web);
        Load += async (_, _) => await StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, _dataFolder);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                "This computer needs the Microsoft Edge WebView2 Runtime. "
                + "Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start Check Desk again.",
                Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        var core = _web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.PermissionRequested += OnPermissionRequested;
        core.WebMessageReceived += OnWebMessageReceived;
        core.DocumentTitleChanged += (_, _) => Text = $"{core.DocumentTitle} · DineroBook Check Desk";
        core.Navigate(_settings.Home);
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (NavigationPolicy.IsOwnPage(e.Uri, _settings.HomeUri)) return;
        e.Cancel = true;
        OpenOutside(e.Uri);
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (NavigationPolicy.IsOwnPage(e.Uri, _settings.HomeUri)) _web.CoreWebView2.Navigate(e.Uri);
        else OpenOutside(e.Uri);
    }

    /// <summary>The webcam (pictures) for DineroBook pages; nothing else
    /// is granted here.</summary>
    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        if (e.PermissionKind == CoreWebView2PermissionKind.Camera
            && NavigationPolicy.IsOwnPage(e.Uri, _settings.HomeUri))
        {
            e.State = CoreWebView2PermissionState.Allow;
        }
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!NavigationPolicy.IsOwnPage(e.Source, _settings.HomeUri)) return;
        var reply = await _bridge.HandleAsync(e.WebMessageAsJson);
        if (reply is not null && !IsDisposed) _web.CoreWebView2?.PostWebMessageAsJson(reply);
    }

    private static void OpenOutside(string address)
    {
        if (!NavigationPolicy.MayOpenOutside(address)) return;
        try
        {
            Process.Start(new ProcessStartInfo(address) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // No default browser: nothing to open it with.
        }
    }
}
