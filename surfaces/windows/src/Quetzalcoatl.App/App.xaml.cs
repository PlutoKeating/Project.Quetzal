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
    private DispatcherQueue? _uiQueue;
    private CognitionDensity _expectedDensity = CognitionDensity.Workbench;

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
        // 只在 UI 线程读一次：线程池上的 Timer 回调绝不能调用 GetForCurrentThread()。
        _uiQueue = DispatcherQueue.GetForCurrentThread();
        _home = HomePaths.Resolve(_options.Home);
        _preferences = new PreferencesStore(_home.PreferencesPath);
        var preferences = _preferences.Load();
        _expectedDensity = preferences.Density;

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

        if (_options.DemoStream > 0)
        {
            // 演示流不依赖守护进程/原生绑定：默认构建也能真实跑通流式 UI 与检视态统计。
            StartStream(_options.DemoStream);
        }

        if (_options.StartMinimized)
        {
            _window.HideToTrayIfPossible();
        }

        var uiQueue = _uiQueue;
        if (_options.ExitAfterSeconds > 0 && uiQueue is not null)
        {
            _exitTimer = new Timer(
                _ => uiQueue.TryEnqueue(() => _window?.Quit()),
                null,
                TimeSpan.FromSeconds(_options.ExitAfterSeconds),
                Timeout.InfiniteTimeSpan);
        }

        // 等一帧让窗口完成布局后再报告，避免把「刚 Activate 还没 mapped」误报为 hidden。
        var reportTimer = uiQueue?.CreateTimer();
        if (reportTimer is null)
        {
            return;
        }

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
        _viewModel.Notice(probe.Connection switch
        {
            ConnectionState.Online => "已通过令牌认证重新连接本机助手。",
            ConnectionState.DetectedUnverified => "发现了本机助手，但握手没有通过；不会显示为已连接。",
            _ => "还是连不上本机助手，请确认它正在运行。",
        });
        if (!probe.BindingsAvailable)
        {
            _viewModel.Notice(CompanionCopy.BindingsUnavailableNotice);
        }
    }

    private void StartStream(int eventCount)
    {
        var uiQueue = _uiQueue;
        if (_viewModel is null || uiQueue is null)
        {
            return;
        }

        var native = StreamSourceFactory.Open(eventCount);
        var source = (IStreamSource?)native ?? new SyntheticStreamSource(eventCount);
        _viewModel.Notice(native is null
            ? "演示流模式：本地合成事件，不连接本机助手。"
            : "已通过本机原生流播放演示事件。");

        _pump?.Dispose();
        _pump = new StreamPump(
            source,
            _viewModel,
            new DispatcherQueuePoster(uiQueue),
            onStats: stats => _viewModel.SetPumpStats(stats));
        _pump.Start();
    }

    private void ReportReady()
    {
        if (_viewModel is null || _window is null)
        {
            return;
        }

        var expectedRows = _options.DemoRows ? 6 : 0;
        var rows = _viewModel.Model.View.Rows.Count;
        var state =
            $"window={(_window.IsVisible ? "visible" : "hidden")} "
            + $"density={_viewModel.Density.Label()} "
            + $"connected={_viewModel.IsOnline} "
            + $"degraded={_viewModel.IsDegraded} "
            + $"bindings={StreamSourceFactory.BindingsAvailable} "
            + $"tray={(_window.TrayActive ? "registered" : "disabled")} "
            + $"rows={rows}";

        if (_options.SelfTest)
        {
            // 自检必须断言真实不变量，而不是只打印一行"成功"。
            var ok = _window.IsVisible && _viewModel.Density == _expectedDensity && rows == expectedRows;
            Report(ok ? $"SELF_TEST_OK {state}" : $"SELF_TEST_FAIL {state} expected_density={_expectedDensity.Label()} expected_rows={expectedRows}");
            if (!ok)
            {
                Environment.ExitCode = 1;
            }

            _window.Quit();
            return;
        }

        if (_options.UiSmoke)
        {
            Report($"UI_SMOKE_READY title={_viewModel.WindowTitle}");
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
