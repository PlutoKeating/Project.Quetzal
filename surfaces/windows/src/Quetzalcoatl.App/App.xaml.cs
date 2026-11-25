namespace Quetzalcoatl.App;

using System.Text;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Quetzalcoatl.App.Services;
using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Settings;
using Quetzalcoatl.Desktop.Streaming;
using Quetzalcoatl.Desktop.ViewModels;
using Quetzalcoatl.Interop;

/// <summary>应用入口：解析启动参数、探测本机守护进程、构建三档窗口并接线托盘/流泵。</summary>
public partial class App : Application
{
    private AppOptions _options = AppOptions.Parse([]);
    private HomePaths _home = HomePaths.Resolve();
    private PreferencesStore? _preferences;
    private DesktopViewModel? _viewModel;
    private MainWindow? _window;
    private StreamPump? _pump;
    private Timer? _exitTimer;

    public App()
    {
        try
        {
            InitializeComponent();
        }
        catch (Exception error)
        {
            StartupDiagnostics.Write("App.InitializeComponent", error);
            throw;
        }
    }

    /// <inheritdoc />
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _ = args;
        _options = AppOptions.Parse(Environment.GetCommandLineArgs());
        UnhandledException += (_, e) => Report($"UNHANDLED_EXCEPTION {e.Exception}");
        try
        {
            Boot();
        }
        catch (Exception error)
        {
            StartupDiagnostics.Write("Boot", error);
            Report($"BOOT_FAIL {error}");
            throw;
        }
    }

    private void Boot()
    {
        _home = HomePaths.Resolve(_options.Home);
        _preferences = new PreferencesStore(_home.PreferencesPath);
        var preferences = _preferences.Load();

        if (_options.InstallStartup)
        {
            var executable = Environment.ProcessPath ?? string.Empty;
            _ = LoginStartup.Enable(executable);
        }

        if (_options.RemoveStartup)
        {
            _ = LoginStartup.Disable();
        }

        var probe = LocalDaemonProbe.Probe(_home, StreamSourceFactory.BindingsAvailable);
        var announcements = new DeferredAnnouncementSink();
        var model = UiModel.FromConnection(probe.Connection, preferences.Density);
        if (_options.DemoRows)
        {
            DemoData.Apply(model);
        }

        _viewModel = new DesktopViewModel(model, announcements);
        _viewModel.Model.Technical(probe.Technical);
        if (!probe.BindingsAvailable)
        {
            _viewModel.Notice(CompanionCopy.BindingsUnavailableNotice);
        }

        _window = new MainWindow(_viewModel, _preferences, announcements);
        _window.RetryRequested += (_, _) => Retry();
        _window.Closed += (_, _) =>
        {
            _pump?.Dispose();
            _pump = null;
            _exitTimer?.Dispose();
            _exitTimer = null;
        };
        _window.Activate();

        if (probe.Connection.IsOnline && _options.DemoStream > 0)
        {
            StartStream(_options.DemoStream);
        }

        if (_options.StartMinimized)
        {
            _window.HideToTrayIfPossible();
        }

        if (_options.ExitAfterSeconds > 0)
        {
            _exitTimer = new Timer(
                _ => DispatcherQueue.GetForCurrentThread().TryEnqueue(() => _window?.Quit()),
                null,
                TimeSpan.FromSeconds(_options.ExitAfterSeconds),
                Timeout.InfiniteTimeSpan);
        }

        // 等一帧让窗口完成布局后再报告，避免把「刚 Activate 还没 mapped」误报为 hidden。
        var reportTimer = DispatcherQueue.GetForCurrentThread().CreateTimer();
        reportTimer.Interval = TimeSpan.FromMilliseconds(600);
        reportTimer.IsRepeating = false;
        reportTimer.Tick += (_, _) => ReportReady();
        reportTimer.Start();
    }

    private void Retry()
    {
        if (_viewModel is null || _window is null)
        {
            return;
        }

        var probe = LocalDaemonProbe.Probe(_home, StreamSourceFactory.BindingsAvailable);
        _viewModel.SetConnection(probe.Connection);
        _viewModel.Model.Technical(probe.Technical);
        _viewModel.Notice(probe.Connection.IsOnline
            ? "已重新连接本机助手。"
            : "还是连不上本机助手，请确认它正在运行。");
        if (!probe.BindingsAvailable)
        {
            _viewModel.Notice(CompanionCopy.BindingsUnavailableNotice);
        }
    }

    private void StartStream(int eventCount)
    {
        if (_viewModel is null)
        {
            return;
        }

        var source = StreamSourceFactory.Open(eventCount);
        if (source is null)
        {
            _viewModel.Notice("这个版本没有链接流式通道，无法播放演示流。");
            return;
        }

        _pump?.Dispose();
        _pump = new StreamPump(source, _viewModel, new DispatcherQueuePoster(DispatcherQueue.GetForCurrentThread()));
        _pump.Start();
    }

    private void ReportReady()
    {
        if (_viewModel is null || _window is null)
        {
            return;
        }

        var state =
            $"SELF_TEST_OK window={(_window.IsVisible ? "visible" : "hidden")} "
            + $"density={_viewModel.Density.Label()} "
            + $"connected={_viewModel.IsOnline} "
            + $"degraded={_viewModel.IsDegraded} "
            + $"bindings={StreamSourceFactory.BindingsAvailable} "
            + $"tray={(_window.TrayActive ? "registered" : "disabled")} "
            + $"rows={_viewModel.Model.View.Rows.Count}";
        Report(state);
        Report(
            $"UI_SMOKE_READY title={_viewModel.WindowTitle} "
            + $"announcements={_viewModel.AnnouncementCount}");

        if (_options.SelfTest)
        {
            _window.Quit();
        }
    }

    private void Report(string line)
    {
        var message = $"[{DateTimeOffset.Now:O}] {line}";
        Console.WriteLine(message);
        if (string.IsNullOrWhiteSpace(_options.ReportPath))
        {
            return;
        }

        try
        {
            var path = _options.ReportPath;
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }

            File.AppendAllText(path, message + Environment.NewLine, Encoding.UTF8);
        }
        catch (Exception)
        {
            // 报告写入失败不影响应用行为。
        }
    }

    /// <summary>把 UI 调度器包装成流泵的 <see cref="IUiDispatcher"/>。</summary>
    private sealed class DispatcherQueuePoster : IUiDispatcher
    {
        private readonly DispatcherQueue _queue;

        public DispatcherQueuePoster(DispatcherQueue queue)
        {
            ArgumentNullException.ThrowIfNull(queue);
            _queue = queue;
        }

        public bool TryPost(Action callback) => _queue.TryEnqueue(() => callback());
    }
}
