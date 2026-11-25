namespace Quetzalcoatl.Desktop.A11y;

using Quetzalcoatl.Desktop.ViewModels;

/// <summary>UI Automation 控件类型（与 <c>AutomationControlType</c> 名称一一对应，便于冒烟比对）。</summary>
public enum ControlKind
{
    /// <summary>窗口。</summary>
    Window,

    /// <summary>通用面板。</summary>
    Pane,

    /// <summary>按钮。</summary>
    Button,

    /// <summary>可编辑文本框。</summary>
    Edit,

    /// <summary>只读文本。</summary>
    Text,

    /// <summary>列表。</summary>
    List,

    /// <summary>标签容器。</summary>
    Tab,

    /// <summary>状态栏/提示条。</summary>
    StatusBar,

    /// <summary>标签项（密度切换）。</summary>
    TabItem,

    /// <summary>菜单项（托盘菜单）。</summary>
    MenuItem,

    /// <summary>进度条。</summary>
    ProgressBar,
}

/// <summary>控件应暴露的 UI Automation 能力（以标志位表达，便于完整性断言）。</summary>
[Flags]
public enum ControlTraits
{
    /// <summary>无附加要求。</summary>
    None = 0,

    /// <summary>可用键盘获得焦点。</summary>
    KeyboardFocusable = 1 << 0,

    /// <summary>应支持 Invoke 模式。</summary>
    Invoke = 1 << 1,

    /// <summary>应支持 Value/Text 模式（输入框）。</summary>
    ValuePattern = 1 << 2,

    /// <summary>应支持 SelectionItem 模式（标签/列表项）。</summary>
    SelectionItem = 1 << 3,
}

/// <summary>控件的可见状态：仅当对应状态成立时才出现在 UI Automation 树中。</summary>
public enum ControlAvailability
{
    /// <summary>始终存在。</summary>
    Always,

    /// <summary>仅流式进行中可见（如流式进度条）。</summary>
    WhileStreaming,

    /// <summary>仅降级/离线时可见（如重连按钮与未连接说明）。</summary>
    WhileDegraded,
}

/// <summary>控件所属的表面（主窗口或托盘菜单）。</summary>
public enum ControlSurface
{
    /// <summary>主窗口内的控件。</summary>
    MainWindow,

    /// <summary>系统托盘原生菜单项。</summary>
    Tray,
}

/// <summary>一个交互控件的无障碍契约条目。</summary>
public sealed record ControlContract(
    string AutomationId,
    string AccessibleName,
    ControlKind Kind,
    ControlTraits Traits,
    int MinTargetPx = 0,
    string Description = "",
    ControlSurface Surface = ControlSurface.MainWindow,
    bool NameIsContent = false,
    bool IsDynamicId = false,
    ControlAvailability Availability = ControlAvailability.Always)
{
    /// <summary>是否需要键盘可达。</summary>
    public bool IsInteractive =>
        (Traits & (ControlTraits.KeyboardFocusable | ControlTraits.Invoke | ControlTraits.ValuePattern | ControlTraits.SelectionItem)) != 0;

    /// <summary>真实 UIA 名称必须与此条目匹配（内容承载控件以实际内容为准）。</summary>
    public bool HasStaticName => !NameIsContent;
}

/// <summary>
/// 桌面端无障碍契约：XAML 的 <c>AutomationProperties.AutomationId</c> /
/// <c>AutomationProperties.Name</c> 必须与此清单逐条一致；单测与 UI Automation 冒烟
/// 共用同一份清单，杜绝「XAML 改了、测试没跟上」的漂移。
/// <para>
/// 内容承载控件（对话正文、标题、连接状态、良知正文）**不设置** <c>AutomationProperties.Name</c>：
/// 屏幕阅读器必须朗读真实内容，而不是「对话内容」「连接状态」这类区块标签；
/// 区块标签改由 <see cref="Description"/> / HelpText 表达。
/// </para>
/// </summary>
public static class DesktopControlCatalog
{
    /// <summary>全部契约条目（含静态条目与模板内动态条目）。</summary>
    public static IReadOnlyList<ControlContract> All { get; } =
    [
        new("nav.density", "视图密度", ControlKind.Tab, ControlTraits.KeyboardFocusable),
        new("tab.companion", "陪伴视图（Ctrl+1）", ControlKind.TabItem, ControlTraits.KeyboardFocusable | ControlTraits.SelectionItem),
        new("tab.workbench", "工作台视图（Ctrl+2）", ControlKind.TabItem, ControlTraits.KeyboardFocusable | ControlTraits.SelectionItem),
        new("tab.inspector", "检视视图（Ctrl+3）", ControlKind.TabItem, ControlTraits.KeyboardFocusable | ControlTraits.SelectionItem),
        new("status.connection", "连接状态提示", ControlKind.Text, ControlTraits.None, NameIsContent: true),
        new("status.degraded", "未连接说明", ControlKind.Text, ControlTraits.None, NameIsContent: true, Availability: ControlAvailability.WhileDegraded),
        new("companion.heading", "陪伴视图标题", ControlKind.Text, ControlTraits.None, NameIsContent: true),
        new(
            "companion.transcript",
            CompanionCopy.TranscriptLabel,
            ControlKind.Text,
            ControlTraits.None,
            0,
            CompanionCopy.TranscriptDescription,
            NameIsContent: true),
        new("companion.hint", "未连接时的说明", ControlKind.Text, ControlTraits.None, NameIsContent: true, Availability: ControlAvailability.WhileDegraded),
        new("companion.entry", "想说的话", ControlKind.Edit, ControlTraits.KeyboardFocusable | ControlTraits.ValuePattern, 64, "输入一句话，按回车或点发送"),
        new("companion.send", "发送这句话", ControlKind.Button, ControlTraits.KeyboardFocusable | ControlTraits.Invoke, 64),
        new("companion.retry", "重新连接本机助手", ControlKind.Button, ControlTraits.KeyboardFocusable | ControlTraits.Invoke, 64, Availability: ControlAvailability.WhileDegraded),
        new("companion.status", "连接状态", ControlKind.Text, ControlTraits.None, NameIsContent: true),
        new("companion.streaming", "正在回复", ControlKind.ProgressBar, ControlTraits.None, Availability: ControlAvailability.WhileStreaming),
        new("workbench.transcript", "工作台对话内容", ControlKind.Text, ControlTraits.None, NameIsContent: true),
        new("workbench.entry", "工作台输入框", ControlKind.Edit, ControlTraits.KeyboardFocusable | ControlTraits.ValuePattern, 32),
        new("workbench.send", "工作台发送按钮", ControlKind.Button, ControlTraits.KeyboardFocusable | ControlTraits.Invoke, 32),
        new("workbench.workflows", "工作流列表", ControlKind.List, ControlTraits.KeyboardFocusable),
        new("workbench.approvals", "待批准操作列表", ControlKind.List, ControlTraits.KeyboardFocusable),
        new("workbench.approve", "批准这项操作", ControlKind.Button, ControlTraits.KeyboardFocusable | ControlTraits.Invoke, 32, IsDynamicId: true),
        new("workbench.deny", "拒绝这项操作", ControlKind.Button, ControlTraits.KeyboardFocusable | ControlTraits.Invoke, 32, IsDynamicId: true),
        new("inspector.conscience", "良知锁定正文", ControlKind.Text, ControlTraits.None, NameIsContent: true),
        new("inspector.tools", "工具调用列表", ControlKind.List, ControlTraits.KeyboardFocusable),
        new("inspector.audit", "审计事件列表", ControlKind.List, ControlTraits.KeyboardFocusable),
        new("inspector.technical", "运行技术日志", ControlKind.List, ControlTraits.KeyboardFocusable),
        new("inspector.pump", "流泵统计", ControlKind.Text, ControlTraits.None, NameIsContent: true),
        new("tray.show", "显示 Quetzalcoatl 主窗口", ControlKind.MenuItem, ControlTraits.Invoke, 0, string.Empty, ControlSurface.Tray),
        new("tray.quit", "退出 Quetzalcoatl", ControlKind.MenuItem, ControlTraits.Invoke, 0, string.Empty, ControlSurface.Tray),
    ];

    /// <summary>按 ID 查找契约条目。</summary>
    public static ControlContract? Find(string automationId) =>
        All.FirstOrDefault(item => string.Equals(item.AutomationId, automationId, StringComparison.Ordinal));

    /// <summary>指定表面的全部条目。</summary>
    public static IReadOnlyList<ControlContract> ForSurface(ControlSurface surface) =>
        All.Where(item => item.Surface == surface).ToArray();

    /// <summary>
    /// 结构性自检：ID 唯一、名称非空（区块标签至少要有可读说明）、可交互控件必须键盘可达、
    /// 陪伴态触点最小尺寸不小于 64px；行级动态 ID 必须是可交互控件、声明静态名称与最小触点。
    /// </summary>
    public static IReadOnlyList<string> ValidateStructure()
    {
        var issues = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in All)
        {
            if (string.IsNullOrWhiteSpace(item.AutomationId))
            {
                issues.Add("存在空 AutomationId 的契约条目");
                continue;
            }

            if (!seen.Add(item.AutomationId))
            {
                issues.Add($"{item.AutomationId}: AutomationId 重复");
            }

            if (string.IsNullOrWhiteSpace(item.AccessibleName) && string.IsNullOrWhiteSpace(item.Description))
            {
                issues.Add($"{item.AutomationId}: 必须提供无障碍名称或区块说明");
            }

            if (item.IsInteractive && (item.Traits & ControlTraits.KeyboardFocusable) == 0
                && item.Surface == ControlSurface.MainWindow)
            {
                issues.Add($"{item.AutomationId}: 可交互控件必须键盘可达");
            }

            if (item.MinTargetPx is > 0 and < 64
                && item.AutomationId.StartsWith("companion.", StringComparison.Ordinal))
            {
                issues.Add($"{item.AutomationId}: 陪伴态触点不得小于 64px（实际 {item.MinTargetPx}px）");
            }

            if (item.IsDynamicId && (!item.IsInteractive || item.MinTargetPx == 0 || item.NameIsContent))
            {
                issues.Add($"{item.AutomationId}: 行级动态 ID 必须是可交互、有静态名称与最小触点的控件");
            }
        }

        return issues;
    }
}

/// <summary>从真实 UI Automation 树读回的一条观测（由冒烟工程填充）。</summary>
public sealed record ObservedControl(
    string AutomationId,
    string? Name,
    ControlKind Kind,
    bool IsKeyboardFocusable,
    bool IsInvokeAvailable,
    bool IsValueAvailable,
    double Width,
    double Height,
    bool IsEnabled = true);

/// <summary>契约与真实 UI Automation 树的差异。</summary>
public static class A11yContractValidator
{
    /// <summary>容器类控件：键盘可达性由子项承载，自身不是 Tab 停靠点。</summary>
    private static bool IsContainerKind(ControlKind kind) =>
        kind is ControlKind.Tab or ControlKind.List or ControlKind.Pane or ControlKind.Window;

    /// <summary>校验观测到的控件集合是否满足指定表面的契约。</summary>
    public static IReadOnlyList<string> Validate(
        IEnumerable<ObservedControl> observed,
        ControlSurface surface = ControlSurface.MainWindow,
        IReadOnlyCollection<string>? onlyIds = null,
        IReadOnlySet<ControlAvailability>? activeStates = null)
    {
        ArgumentNullException.ThrowIfNull(observed);
        var items = observed.Where(item => !string.IsNullOrEmpty(item.AutomationId)).ToArray();
        var issues = new List<string>();

        foreach (var contract in DesktopControlCatalog.ForSurface(surface))
        {
            if (onlyIds is not null && !onlyIds.Contains(contract.AutomationId))
            {
                continue;
            }

            // 条件可见控件（重连/未连接说明/流式进度）只在对应状态成立时才要求出现在 UIA 树。
            if (contract.Availability != ControlAvailability.Always
                && (activeStates is null || !activeStates.Contains(contract.Availability)))
            {
                continue;
            }

            // 动态 ID（行内按钮）按前缀匹配，且每一行都必须唯一、名称一致。
            var matches = contract.IsDynamicId
                ? items.Where(item => item.AutomationId.StartsWith(contract.AutomationId + "/", StringComparison.Ordinal)).ToArray()
                : items.Where(item => string.Equals(item.AutomationId, contract.AutomationId, StringComparison.Ordinal)).ToArray();

            if (matches.Length == 0)
            {
                issues.Add($"{contract.AutomationId}: UI Automation 树中缺失");
                continue;
            }

            if (contract.IsDynamicId && matches.Select(match => match.AutomationId).Distinct(StringComparer.Ordinal).Count() != matches.Length)
            {
                issues.Add($"{contract.AutomationId}: 行内按钮的 AutomationId 必须唯一");
            }

            if (contract.HasStaticName
                && matches.Any(match => !string.Equals(match.Name, contract.AccessibleName, StringComparison.Ordinal)))
            {
                issues.Add(
                    $"{contract.AutomationId}: 名称不一致（期望「{contract.AccessibleName}」，实际「{matches[0].Name}」）");
            }

            if (contract.NameIsContent
                && matches.Any(match => string.IsNullOrWhiteSpace(match.Name)
                    || string.Equals(match.Name, contract.AccessibleName, StringComparison.Ordinal)))
            {
                issues.Add($"{contract.AutomationId}: 内容承载控件必须朗读真实内容，而不是区块标签「{contract.AccessibleName}」");
            }

            if (matches.Any(match => match.Kind != contract.Kind))
            {
                issues.Add(
                    $"{contract.AutomationId}: 控件类型不一致（期望 {contract.Kind}，实际 {matches[0].Kind}）");
            }

            // 键盘可达只对「此刻真的可用」的叶子控件成立：
            // * 禁用的控件（例如离线时的输入框）在 UIA 里本来就不是焦点目标；
            // * 容器（标签页/列表）自己不是 Tab 停靠点，可达性由它们的子项承载，
            //   因此容器只校验名称/类型，子项（tab.* / workbench.* 行）各自有契约。
            if ((contract.Traits & ControlTraits.KeyboardFocusable) != 0
                && !IsContainerKind(contract.Kind)
                && matches.Any(match => match.IsEnabled && !match.IsKeyboardFocusable))
            {
                issues.Add($"{contract.AutomationId}: 必须可用键盘聚焦");
            }

            if ((contract.Traits & ControlTraits.Invoke) != 0 && !matches.Any(match => match.IsInvokeAvailable))
            {
                issues.Add($"{contract.AutomationId}: 必须暴露 Invoke 模式");
            }

            if ((contract.Traits & ControlTraits.ValuePattern) != 0 && !matches.Any(match => match.IsValueAvailable))
            {
                issues.Add($"{contract.AutomationId}: 必须暴露 Value/Text 模式");
            }

            if (contract.MinTargetPx > 0
                && matches.Any(match => match.Width < contract.MinTargetPx || match.Height < contract.MinTargetPx))
            {
                issues.Add($"{contract.AutomationId}: 触点小于 {contract.MinTargetPx}px");
            }
        }

        return issues;
    }
}
