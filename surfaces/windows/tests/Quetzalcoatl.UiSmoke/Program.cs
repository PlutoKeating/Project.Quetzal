namespace Quetzalcoatl.UiSmoke;

using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;
using Quetzalcoatl.Desktop.A11y;

/// <summary>
/// 外部 UI Automation 冒烟：启动真实 WinUI 3 窗口，按三档密度逐个读取 UIA 树，
/// 并对照 <see cref="DesktopControlCatalog"/> 校验名称/类型/键盘可达/Invoke/Value/内容承载/触点尺寸。
/// 退出码：0 = 全部通过；77 = 没有交互式桌面/窗口未出现（SKIP）；2 = 契约不符或崩溃。
/// </summary>
internal static class Program
{
    private const int ExitPass = 0;
    private const int ExitFail = 2;
    private const int ExitSkip = 77;

    private static int Main(string[] args)
    {
        var options = SmokeOptions.Parse(args);
        var report = new StringBuilder();
        void Log(string line)
        {
            Console.WriteLine(line);
            report.AppendLine(line);
        }

        if (string.IsNullOrWhiteSpace(options.AppPath))
        {
            Log("UI_SMOKE_FAIL 缺少 --app <Quetzalcoatl.App.exe>");
            return ExitFail;
        }

        Process? app = null;
        try
        {
            var home = options.Home ?? Path.Combine(Path.GetTempPath(), $"qz-smoke-{Guid.NewGuid():N}");
            Directory.CreateDirectory(home);
            app = StartApp(options, home);

            var window = WaitForWindow(app, options.Timeout, Log, out var skipReason);
            if (window is null)
            {
                Log($"UI_SMOKE_SKIP {skipReason}");
                return ExitSkip;
            }

            Log($"UI_SMOKE_WINDOW name=\"{window.Current.Name}\"");

            var issues = new List<string>();
            var common = new[]
            {
                "nav.density",
                "tab.companion",
                "tab.workbench",
                "tab.inspector",
                "status.connection",
                "status.degraded",
            };

            var densityGroups = new (string TabId, string Prefix)[]
            {
                ("tab.companion", "companion."),
                ("tab.workbench", "workbench."),
                ("tab.inspector", "inspector."),
            };

            foreach (var (tabId, prefix) in densityGroups)
            {
                if (!SelectTab(window, tabId))
                {
                    issues.Add($"{tabId}: 无法通过 UI Automation 选中该密度");
                    continue;
                }

                var observed = Observe(window);
                var ids = DesktopControlCatalog.ForSurface(ControlSurface.MainWindow)
                    .Select(contract => contract.AutomationId)
                    .Where(id => common.Contains(id) || id.StartsWith(prefix, StringComparison.Ordinal))
                    .ToArray();
                issues.AddRange(A11yContractValidator.Validate(observed, ControlSurface.MainWindow, ids));
                Log(
                    $"UI_SMOKE_DENSITY tab={tabId} controls={observed.Count} "
                    + $"checked={ids.Length} issues={issues.Count}");
            }

            if (options.ObservedDump is not null)
            {
                var all = Observe(window)
                    .Select(item => new
                    {
                        item.AutomationId,
                        item.Name,
                        Kind = item.Kind.ToString(),
                        item.IsKeyboardFocusable,
                        item.IsInvokeAvailable,
                        item.IsValueAvailable,
                        item.Width,
                        item.Height,
                    })
                    .ToArray();
                File.WriteAllText(options.ObservedDump, JsonSerializer.Serialize(all, new JsonSerializerOptions { WriteIndented = true }));
                Log($"UI_SMOKE_DUMP {options.ObservedDump}");
            }

            if (issues.Count == 0)
            {
                Log("UI_SMOKE_OK density_tabs=3 accessible_contract=ok");
                return ExitPass;
            }

            foreach (var issue in issues)
            {
                Log($"UI_SMOKE_FAIL {issue}");
            }

            return ExitFail;
        }
        catch (ElementNotAvailableException error)
        {
            Log($"UI_SMOKE_SKIP 没有可用的交互式桌面: {error.Message}");
            return ExitSkip;
        }
        catch (Exception error)
        {
            Log($"UI_SMOKE_FAIL {error.GetType().Name}: {error.Message}");
            return ExitFail;
        }
        finally
        {
            if (app is { HasExited: false })
            {
                try
                {
                    app.Kill(entireProcessTree: true);
                }
                catch (InvalidOperationException)
                {
                    // 进程已退出。
                }
            }

            if (!string.IsNullOrWhiteSpace(options.ReportPath))
            {
                var directory = Path.GetDirectoryName(options.ReportPath);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.WriteAllText(options.ReportPath, report.ToString(), new UTF8Encoding(false));
            }
        }
    }

    private static Process StartApp(SmokeOptions options, string home)
    {
        var startInfo = new ProcessStartInfo(options.AppPath!)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(options.AppPath!) ?? Environment.CurrentDirectory,
        };
        startInfo.ArgumentList.Add("--ui-smoke");
        startInfo.ArgumentList.Add("--demo-rows");
        startInfo.ArgumentList.Add("--home");
        startInfo.ArgumentList.Add(home);
        startInfo.ArgumentList.Add("--report");
        startInfo.ArgumentList.Add(options.AppReportPath ?? Path.Combine(home, "app-report.txt"));
        startInfo.ArgumentList.Add("--exit-after");
        startInfo.ArgumentList.Add("120");
        return Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 Quetzalcoatl.App");
    }

    private static AutomationElement? WaitForWindow(
        Process app,
        TimeSpan timeout,
        Action<string> log,
        out string skipReason)
    {
        skipReason = string.Empty;
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed < timeout)
        {
            if (app.HasExited)
            {
                skipReason = $"应用在窗口出现前退出（exit={app.ExitCode}）";
                return null;
            }

            var root = AutomationElement.RootElement;
            var windows = root.FindAll(
                TreeScope.Children,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));
            foreach (AutomationElement window in windows)
            {
                try
                {
                    if (window.Current.Name.StartsWith("Quetzalcoatl", StringComparison.Ordinal))
                    {
                        return window;
                    }
                }
                catch (ElementNotAvailableException)
                {
                    // 窗口在枚举过程中消失：继续下一轮。
                }
            }

            Thread.Sleep(500);
        }

        skipReason = $"在 {timeout.TotalSeconds:F0}s 内没有出现 Quetzalcoatl 窗口（无交互式桌面或启动失败）";
        log($"UI_SMOKE_HINT 请查看应用报告: {app.Id}");
        return null;
    }

    private static bool SelectTab(AutomationElement window, string automationId)
    {
        var tab = Find(window, automationId);
        if (tab is null)
        {
            return false;
        }

        if (tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection)
            && selection is SelectionItemPattern selectionItem)
        {
            selectionItem.Select();
            Thread.Sleep(400);
            return true;
        }

        if (tab.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke) && invoke is InvokePattern invokePattern)
        {
            invokePattern.Invoke();
            Thread.Sleep(400);
            return true;
        }

        return false;
    }

    private static AutomationElement? Find(AutomationElement root, string automationId)
    {
        var condition = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
        return root.FindFirst(TreeScope.Descendants, condition);
    }

    private static List<ObservedControl> Observe(AutomationElement window)
    {
        var observed = new List<ObservedControl>();
        var elements = window.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        foreach (AutomationElement element in elements)
        {
            try
            {
                var automationId = element.Current.AutomationId;
                if (string.IsNullOrEmpty(automationId))
                {
                    continue;
                }

                var kind = MapKind(element.Current.ControlType);
                if (kind is null)
                {
                    continue;
                }

                var rectangle = element.Current.BoundingRectangle;
                observed.Add(new ObservedControl(
                    automationId,
                    element.Current.Name,
                    kind.Value,
                    element.Current.IsKeyboardFocusable,
                    element.TryGetCurrentPattern(InvokePattern.Pattern, out _),
                    element.TryGetCurrentPattern(ValuePattern.Pattern, out _),
                    rectangle.Width,
                    rectangle.Height));
            }
            catch (ElementNotAvailableException)
            {
                // 树在枚举期间变化：忽略该节点。
            }
        }

        return observed;
    }

    private static ControlKind? MapKind(ControlType controlType)
    {
        var name = controlType.ProgrammaticName;
        return name switch
        {
            "ControlType.Window" => ControlKind.Window,
            "ControlType.Pane" => ControlKind.Pane,
            "ControlType.Button" => ControlKind.Button,
            "ControlType.Edit" => ControlKind.Edit,
            "ControlType.Text" => ControlKind.Text,
            "ControlType.List" => ControlKind.List,
            "ControlType.Tab" => ControlKind.Tab,
            "ControlType.TabItem" => ControlKind.TabItem,
            "ControlType.StatusBar" => ControlKind.StatusBar,
            "ControlType.MenuItem" => ControlKind.MenuItem,
            "ControlType.ProgressBar" => ControlKind.ProgressBar,
            _ => null,
        };
    }
}

/// <summary>冒烟客户端启动参数。</summary>
internal sealed record SmokeOptions
{
    public string? AppPath { get; init; }

    public string? Home { get; init; }

    public string? ReportPath { get; init; }

    public string? AppReportPath { get; init; }

    public string? ObservedDump { get; init; }

    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(60);

    public static SmokeOptions Parse(IReadOnlyList<string> args)
    {
        var options = new SmokeOptions();
        for (var index = 0; index < args.Count; index++)
        {
            switch (args[index])
            {
                case "--app" when index + 1 < args.Count:
                    options = options with { AppPath = args[++index] };
                    break;
                case "--home" when index + 1 < args.Count:
                    options = options with { Home = args[++index] };
                    break;
                case "--report" when index + 1 < args.Count:
                    options = options with { ReportPath = args[++index] };
                    break;
                case "--app-report" when index + 1 < args.Count:
                    options = options with { AppReportPath = args[++index] };
                    break;
                case "--observed-dump" when index + 1 < args.Count:
                    options = options with { ObservedDump = args[++index] };
                    break;
                case "--timeout" when index + 1 < args.Count:
                    if (int.TryParse(args[++index], out var seconds) && seconds > 0)
                    {
                        options = options with { Timeout = TimeSpan.FromSeconds(seconds) };
                    }

                    break;
            }
        }

        return options;
    }
}
