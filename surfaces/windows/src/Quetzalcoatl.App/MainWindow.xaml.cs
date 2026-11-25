namespace Quetzalcoatl.App;

using System.ComponentModel;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Quetzalcoatl.App.Services;
using Quetzalcoatl.App.Views;
using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Settings;
using Quetzalcoatl.Desktop.ViewModels;

/// <summary>
/// 主窗口：三档密度（TabView 原生标签语义）、Fluent 主题、系统托盘驻留与实时播报接线。
/// 窗口本身只做投影渲染；所有状态变更都由 <see cref="DesktopViewModel"/> 驱动。
/// </summary>
public sealed partial class MainWindow : Window
{
    private static readonly CognitionDensity[] DensityOrder =
    [
        CognitionDensity.Companion,
        CognitionDensity.Workbench,
        CognitionDensity.Inspector,
    ];

    private readonly PreferencesStore _preferences;
    private readonly DeferredAnnouncementSink _announcements;
    private TrayIcon? _tray;
    private bool _syncingDensity;
    private bool _quitting;

    public MainWindow(
        DesktopViewModel viewModel,
        PreferencesStore preferences,
        DeferredAnnouncementSink announcements)
    {
        ArgumentNullException.ThrowIfNull(viewModel);
        ArgumentNullException.ThrowIfNull(preferences);
        ArgumentNullException.ThrowIfNull(announcements);

        ViewModel = viewModel;
        _preferences = preferences;
        _announcements = announcements;

        InitializeComponent();
        RootGrid.DataContext = viewModel;
        Title = viewModel.WindowTitle;

        var saved = preferences.Load();
        AppWindow.Resize(new Windows.Graphics.SizeInt32 { Width = saved.Width, Height = saved.Height });
        if (saved.Maximized && AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.Maximize();
        }

        try
        {
            // Fluent 材质：Windows 11 上是 Mica，Windows 10 自动退化为纯色背景。
            SystemBackdrop = new MicaBackdrop();
        }
        catch (Exception)
        {
            // 材质不是可用性前提。
        }

        DensityTabs.SelectedIndex = IndexOfDensity(viewModel.Density);
        Companion.MessageSubmitted += OnMessageSubmitted;
        Companion.RetryRequested += OnRetryRequested;
        Workbench.MessageSubmitted += OnMessageSubmitted;
        Workbench.ApprovalDecided += OnApprovalDecided;
        viewModel.PropertyChanged += OnViewModelPropertyChanged;
        _announcements.Attach(Announce);

        AppWindow.Closing += OnWindowClosing;
        _tray = TrayIcon.Create("Quetzalcoatl", ShowFromTray, Quit);
    }

    /// <summary>用户请求重新探测本机助手（由 App 重新执行探测并回写视图模型）。</summary>
    public event EventHandler? RetryRequested;

    /// <summary>视图模型。</summary>
    public DesktopViewModel ViewModel { get; }

    /// <summary>窗口是否可见（自检/冒烟报告使用）。</summary>
    public bool IsVisible => AppWindow.IsVisible;

    /// <summary>当前密度标识。</summary>
    public string DensityLabel => ViewModel.Density.Label();

    /// <summary>托盘是否成功注册（自检报告使用）。</summary>
    public bool TrayActive => _tray?.IsActive == true;

    /// <summary>主动退出（托盘菜单、自检与冒烟共用）。</summary>
    public void Quit()
    {
        if (_quitting)
        {
            return;
        }

        _quitting = true;
        PersistPreferences();
        _tray?.Dispose();
        _tray = null;
        Application.Current.Exit();
    }

    /// <summary>登录自启时直接隐藏到托盘（托盘不可用时保持窗口可见）。</summary>
    public void HideToTrayIfPossible()
    {
        if (_tray?.IsActive == true)
        {
            AppWindow.Hide();
        }
    }

    private static int IndexOfDensity(CognitionDensity density) => Array.IndexOf(DensityOrder, density);

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        switch (e.PropertyName)
        {
            case nameof(DesktopViewModel.WindowTitle):
                Title = ViewModel.WindowTitle;
                break;
            case nameof(DesktopViewModel.Density):
                SyncTabToDensity();
                break;
        }
    }

    private void SyncTabToDensity()
    {
        var index = IndexOfDensity(ViewModel.Density);
        if (index < 0 || DensityTabs.SelectedIndex == index)
        {
            return;
        }

        _syncingDensity = true;
        DensityTabs.SelectedIndex = index;
        _syncingDensity = false;
    }

    private void OnDensitySelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_syncingDensity)
        {
            return;
        }

        if (DensityTabs.SelectedItem is not TabViewItem item
            || item.Tag is not string tag
            || !Enum.TryParse<CognitionDensity>(tag, out var density))
        {
            return;
        }

        SetDensity(density);
    }

    private void SetDensity(CognitionDensity density)
    {
        ViewModel.ApplyDensity(density);
        PersistPreferences();
    }

    private void OnCompanionAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        _ = sender;
        SetDensity(CognitionDensity.Companion);
        args.Handled = true;
    }

    private void OnWorkbenchAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        _ = sender;
        SetDensity(CognitionDensity.Workbench);
        args.Handled = true;
    }

    private void OnInspectorAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        _ = sender;
        SetDensity(CognitionDensity.Inspector);
        args.Handled = true;
    }

    private void OnMessageSubmitted(object? sender, string text)
    {
        _ = sender;
        ViewModel.PushUserMessage(text);
        if (ViewModel.IsOnline)
        {
            ViewModel.Notice("这句话已经记下；对话通道还没有接入这个界面。");
        }
    }

    private void OnRetryRequested(object? sender, EventArgs e)
    {
        _ = sender;
        _ = e;
        RetryRequested?.Invoke(this, EventArgs.Empty);
    }

    private void OnApprovalDecided(object? sender, ApprovalDecision decision)
    {
        _ = sender;
        ViewModel.Notice(
            decision.Approved
                ? $"已记下「批准」：{decision.Key}。等本机助手接通后才会真正生效。"
                : $"已记下「拒绝」：{decision.Key}。等本机助手接通后才会真正生效。");
    }

    private void Announce(string text)
    {
        LiveAnnouncement.Text = text;
        try
        {
            var peer = FrameworkElementAutomationPeer.FromElement(LiveAnnouncement)
                ?? FrameworkElementAutomationPeer.CreatePeerForElement(LiveAnnouncement);
            peer?.RaiseNotificationEvent(
                AutomationNotificationKind.ActionCompleted,
                AutomationNotificationProcessing.MostRecent,
                text,
                "qz.streaming");
        }
        catch (Exception)
        {
            // 无障碍通知失败不影响正文渲染。
        }
    }

    private void OnWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        PersistPreferences();
        if (_quitting || _tray?.IsActive != true)
        {
            return;
        }

        if (_preferences.Load().CloseToTray)
        {
            args.Cancel = true;
            sender.Hide();
        }
    }

    private void ShowFromTray()
    {
        AppWindow.Show();
        Activate();
    }

    private void PersistPreferences()
    {
        try
        {
            var current = _preferences.Load();
            var size = AppWindow.Size;
            var maximized = AppWindow.Presenter is OverlappedPresenter presenter
                && presenter.State == OverlappedPresenterState.Maximized;
            _preferences.Save(current with
            {
                Density = ViewModel.Density,
                Width = size.Width,
                Height = size.Height,
                Maximized = maximized,
            });
        }
        catch (Exception)
        {
            // 偏好写入失败不影响退出路径。
        }
    }
}
