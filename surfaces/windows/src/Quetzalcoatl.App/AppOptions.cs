namespace Quetzalcoatl.App;

/// <summary>启动参数（自检、UI 冒烟、演示流、登录自启与产物报告）。</summary>
public sealed record AppOptions
{
    /// <summary>显式 Quetzalcoatl 家目录。</summary>
    public string? Home { get; init; }

    /// <summary>无头自检：写报告后立即退出。</summary>
    public bool SelfTest { get; init; }

    /// <summary>UI 自动化冒烟：保持窗口运行，供外部 UIA 客户端检查。</summary>
    public bool UiSmoke { get; init; }

    /// <summary>报告输出文件路径。</summary>
    public string? ReportPath { get; init; }

    /// <summary>演示拉模式流的事件数（0 = 不启动）。</summary>
    public int DemoStream { get; init; }

    /// <summary>注入确定性合成视图行（UI 冒烟渲染审批/工作流/工具/审计区）。</summary>
    public bool DemoRows { get; init; }

    /// <summary>指定秒数后自动退出（冒烟超时兜底）。</summary>
    public int ExitAfterSeconds { get; init; }

    /// <summary>启动后直接隐藏到托盘（登录自启使用）。</summary>
    public bool StartMinimized { get; init; }

    /// <summary>写入登录自启注册项。</summary>
    public bool InstallStartup { get; init; }

    /// <summary>删除登录自启注册项。</summary>
    public bool RemoveStartup { get; init; }

    /// <summary>解析命令行参数；未知参数忽略。</summary>
    public static AppOptions Parse(IReadOnlyList<string> arguments)
    {
        ArgumentNullException.ThrowIfNull(arguments);
        var home = default(string);
        var report = default(string);
        var selfTest = false;
        var uiSmoke = false;
        var startMinimized = false;
        var installStartup = false;
        var removeStartup = false;
        var demoStream = 0;
        var demoRows = false;
        var exitAfter = 0;

        for (var index = 0; index < arguments.Count; index++)
        {
            var argument = arguments[index];
            switch (argument)
            {
                case "--home" when index + 1 < arguments.Count:
                    home = arguments[++index];
                    break;
                case "--report" when index + 1 < arguments.Count:
                    report = arguments[++index];
                    break;
                case "--demo-stream" when index + 1 < arguments.Count:
                    if (int.TryParse(arguments[++index], out var events) && events > 0)
                    {
                        demoStream = events;
                    }

                    break;
                case "--exit-after" when index + 1 < arguments.Count:
                    if (int.TryParse(arguments[++index], out var seconds) && seconds > 0)
                    {
                        exitAfter = seconds;
                    }

                    break;
                case "--self-test":
                    selfTest = true;
                    break;
                case "--demo-rows":
                    demoRows = true;
                    break;
                case "--ui-smoke":
                    uiSmoke = true;
                    break;
                case "--minimized":
                    startMinimized = true;
                    break;
                case "--install-startup":
                    installStartup = true;
                    break;
                case "--remove-startup":
                    removeStartup = true;
                    break;
            }
        }

        return new AppOptions
        {
            Home = home,
            ReportPath = report,
            SelfTest = selfTest,
            UiSmoke = uiSmoke,
            DemoStream = demoStream,
            DemoRows = demoRows,
            ExitAfterSeconds = exitAfter,
            StartMinimized = startMinimized,
            InstallStartup = installStartup,
            RemoveStartup = removeStartup,
        };
    }
}
