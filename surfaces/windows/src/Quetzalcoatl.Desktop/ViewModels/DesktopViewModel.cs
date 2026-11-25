namespace Quetzalcoatl.Desktop.ViewModels;

using System.ComponentModel;
using System.Runtime.CompilerServices;
using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Streaming;

/// <summary>
/// 桌面端视图模型：唯一可绑定的状态出口。所有成员（除 <see cref="ApplyDensity"/> 的纯模型计算）
/// 都必须在 UI 线程调用；后台线程只经 <see cref="StreamPump"/> 的调度器投递批次。
/// </summary>
public sealed class DesktopViewModel : INotifyPropertyChanged, IStreamSink
{
    private readonly StreamingAnnouncer _announcer;
    private string? _pumpSummary;

    /// <summary>以指定模型构造视图模型。</summary>
    public DesktopViewModel(UiModel model, IAnnouncementSink announcementSink)
    {
        ArgumentNullException.ThrowIfNull(model);
        ArgumentNullException.ThrowIfNull(announcementSink);
        Model = model;
        _announcer = new StreamingAnnouncer(announcementSink);
    }

    /// <inheritdoc />
    public event PropertyChangedEventHandler? PropertyChanged;

    /// <summary>底层模型（仅检视态可读，测试可直接断言）。</summary>
    public UiModel Model { get; }

    /// <summary>当前密度。</summary>
    public CognitionDensity Density => Model.Density;

    /// <summary>密度中文标题。</summary>
    public string DensityLabel => Model.Density.Title();

    /// <summary>窗口标题。</summary>
    public string WindowTitle => Model.Density.WindowTitle();

    /// <summary>是否在线。</summary>
    public bool IsOnline => Model.Connection.IsOnline;

    /// <summary>是否处于降级状态。</summary>
    public bool IsDegraded => Model.Degraded is not null;

    /// <summary>降级标题（在线时为空串）。</summary>
    public string DegradedTitle => Model.Degraded?.Title ?? string.Empty;

    /// <summary>降级解释与动作。</summary>
    public string DegradedDetail => Model.Degraded is null ? string.Empty : $"{Model.Degraded.Detail} {Model.Degraded.Hint}";

    /// <summary>陪伴态标题。</summary>
    public string Heading => IsDegraded ? CompanionCopy.HeadingOffline : CompanionCopy.HeadingOnline;

    /// <summary>对话正文（在线无对话时给引导语）。</summary>
    public string Transcript
    {
        get
        {
            if (Model.Session.Messages.Count > 0)
            {
                return Model.Session.Transcript();
            }

            return IsDegraded ? CompanionCopy.EmptyOffline : CompanionCopy.EmptyOnline;
        }
    }

    /// <summary>工作台的流式回复正文（最近一条助手消息或空串）。</summary>
    public string StreamingText => Model.LastAssistantText() ?? string.Empty;

    /// <summary>离线说明（在线时为空串）。</summary>
    public string HintText => IsDegraded ? DegradedDetail : string.Empty;

    /// <summary>是否显示离线说明。</summary>
    public bool ShowHint => IsDegraded;

    /// <summary>是否显示「重新连接」。</summary>
    public bool ShowRetry => IsDegraded;

    /// <summary>是否允许输入。</summary>
    public bool IsInputEnabled => IsOnline;

    /// <summary>
    /// 连接状态短句（只反映连接，不随每批流变化）：
    /// <c>status.connection</c> 是 LiveSetting 区域，绝不能被每批回复触发第二次播报。
    /// </summary>
    public string StatusText => Model.Degraded is not null
        ? CompanionCopy.StatusOffline
        : CompanionCopy.StatusOnline;

    /// <summary>流式进行中的可视提示（非实时区域，不会自动播报）。</summary>
    public string StreamingIndicator => Model.Session.Streaming ? CompanionCopy.StatusStreaming : string.Empty;

    /// <summary>是否正在流式接收。</summary>
    public bool IsStreaming => Model.Session.Streaming;

    /// <summary>已发生的实时播报次数（测试断言「每批恰好一次」）。</summary>
    public int AnnouncementCount => _announcer.AnnouncementCount;

    /// <summary>最近一次播报文本。</summary>
    public string LastAnnouncement => _announcer.LastAnnouncement ?? string.Empty;

    /// <summary>工作台：会话行。</summary>
    public IReadOnlyList<ViewRow> Sessions => Model.RowsOf(UiModel.KindSession);

    /// <summary>工作台：工作流行。</summary>
    public IReadOnlyList<ViewRow> Workflows => Model.RowsOf(UiModel.KindWorkflow);

    /// <summary>工作台：待批准操作行。</summary>
    public IReadOnlyList<ViewRow> Approvals => Model.RowsOf(UiModel.KindApproval);

    /// <summary>检视：工具调用行。</summary>
    public IReadOnlyList<ViewRow> Tools => Model.RowsOf(UiModel.KindTool);

    /// <summary>检视：审计事件行。</summary>
    public IReadOnlyList<ViewRow> AuditRows => Model.RowsOf(UiModel.KindAudit);

    /// <summary>检视：运行状态行。</summary>
    public IReadOnlyList<ViewRow> StatusRows => Model.RowsOf(UiModel.KindStatus);

    /// <summary>检视：良知锁定正文。</summary>
    public string ConscienceBody => Model.ConscienceBody ?? "尚未读取良知锁定正文。";

    /// <summary>本地提示（零术语）。</summary>
    public IReadOnlyList<string> Notices => Model.Notices;

    /// <summary>运行技术日志（仅检视态）。</summary>
    public IReadOnlyList<string> TechnicalLog => Model.TechnicalLog;

    /// <summary>流泵可观测摘要（仅检视态）。</summary>
    public string PumpSummary => _pumpSummary ?? "流泵未启动。";

    /// <summary>切换密度：只推进纯密度补丁，保留全部会话/流状态。</summary>
    public void ApplyDensity(CognitionDensity density)
    {
        if (!Model.SetDensity(density))
        {
            return;
        }

        RaiseAll();
    }

    /// <summary>更新连接状态（不伪造在线：必须由真实探测结果驱动）。</summary>
    public void SetConnection(ConnectionState connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        Model.Connection = connection;
        RaiseAll();
    }

    /// <summary>追加用户消息（本地回显）。离线时只留本地提示。</summary>
    public void PushUserMessage(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        Model.PushUserMessage(text);
        if (!IsOnline)
        {
            Model.Notice(CompanionCopy.OfflineSendNotice);
        }

        RaiseAll();
    }

    /// <summary>记录一条本地提示。</summary>
    public void Notice(string text)
    {
        Model.Notice(text);
        RaiseAll();
    }

    /// <summary>收束当前流。</summary>
    public void FinishStream()
    {
        Model.FinishStream();
        RaiseAll();
    }

    /// <summary>记录流泵统计摘要。</summary>
    public void SetPumpStats(PumpStats stats)
    {
        ArgumentNullException.ThrowIfNull(stats);
        _pumpSummary =
            $"流泵：事件 {stats.PulledEvents}，合并批次 {stats.AppliedBatches}，"
            + $"合并拉取 {stats.CoalescedPulls}，最大调度延迟 {stats.MaxDispatchLatencyMs:F1}ms，"
            + $"完成 {stats.Completed}，故障 {stats.Faulted}";
        Raise(nameof(PumpSummary));
    }

    /// <inheritdoc />
    public void OnBatch(IReadOnlyList<StreamEvent> events)
    {
        var ingest = Model.IngestStream(events);
        _announcer.AnnounceOnce(ingest);
        RaiseAll();
    }

    /// <inheritdoc />
    public void OnCompleted() => RaiseAll();

    /// <inheritdoc />
    public void OnFaulted(Exception error)
    {
        Model.FinishStream();
        Model.Notice("这次没有收到回复，请稍后重试。");
        Model.Technical($"流中断: {error.GetType().Name}: {error.Message}");
        RaiseAll();
    }

    private void RaiseAll()
    {
        Raise(
            nameof(Density),
            nameof(DensityLabel),
            nameof(WindowTitle),
            nameof(IsOnline),
            nameof(IsDegraded),
            nameof(DegradedTitle),
            nameof(DegradedDetail),
            nameof(Heading),
            nameof(Transcript),
            nameof(StreamingText),
            nameof(HintText),
            nameof(ShowHint),
            nameof(ShowRetry),
            nameof(IsInputEnabled),
            nameof(StatusText),
            nameof(StreamingIndicator),
            nameof(IsStreaming),
            nameof(AnnouncementCount),
            nameof(LastAnnouncement),
            nameof(Sessions),
            nameof(Workflows),
            nameof(Approvals),
            nameof(Tools),
            nameof(AuditRows),
            nameof(StatusRows),
            nameof(ConscienceBody),
            nameof(Notices),
            nameof(TechnicalLog));
    }

    private void Raise(params string[] names)
    {
        var handler = PropertyChanged;
        if (handler is null)
        {
            return;
        }

        foreach (var name in names)
        {
            handler(this, new PropertyChangedEventArgs(name));
        }
    }
}
