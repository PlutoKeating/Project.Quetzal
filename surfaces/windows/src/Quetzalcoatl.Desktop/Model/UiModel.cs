namespace Quetzalcoatl.Desktop.Model;

/// <summary>
/// 桌面端 UI 模型：三档认知密度的差分视图 + 会话/流状态 + 类型化连接状态。
/// <para>
/// 该模型完全由拉模式流事件与补丁驱动，自身不持有任何数据库连接；Windows 端
/// 只经 <c>Quetzalcoatl.Interop</c> 的 UniFFI 薄接口访问守护进程，绝不打开脊柱。
/// </para>
/// </summary>
public sealed class UiModel
{
    /// <summary>会话行类型。</summary>
    public const string KindSession = "session";

    /// <summary>项目行类型。</summary>
    public const string KindProject = "project";

    /// <summary>待审批动作行类型。</summary>
    public const string KindApproval = "approval";

    /// <summary>工作流行类型。</summary>
    public const string KindWorkflow = "workflow";

    /// <summary>良知树节点行类型。</summary>
    public const string KindConscience = "conscience";

    /// <summary>工具调用行类型。</summary>
    public const string KindTool = "tool";

    /// <summary>审计事件行类型。</summary>
    public const string KindAudit = "audit";

    /// <summary>运行状态行类型（仅检视态）。</summary>
    public const string KindStatus = "status";

    /// <summary>构造离线模型（无守护进程时不静默直连数据库）。</summary>
    public static UiModel Offline(string reason, CognitionDensity density = CognitionDensity.Workbench) =>
        new(
            new ViewState(0, density),
            new ConnectionState.Offline(DegradedCopy.For(DegradedReason.DaemonUnavailable, reason)));

    /// <summary>构造在线模型。</summary>
    public static UiModel Online(uint pid, string endpoint, int spineEvents, CognitionDensity density) =>
        new(new ViewState(0, density), new ConnectionState.Online(pid, endpoint, spineEvents));

    /// <summary>以任意类型化连接状态构造模型（探测结果直接驱动，绝不伪造在线）。</summary>
    public static UiModel FromConnection(ConnectionState connection, CognitionDensity density)
    {
        ArgumentNullException.ThrowIfNull(connection);
        return new UiModel(new ViewState(0, density), connection);
    }

    private UiModel(ViewState view, ConnectionState connection)
    {
        View = view;
        Connection = connection;
    }

    /// <summary>差分视图快照（含当前密度）。</summary>
    public ViewState View { get; }

    /// <summary>会话与流状态。</summary>
    public SessionState Session { get; } = new();

    /// <summary>连接状态。</summary>
    public ConnectionState Connection { get; set; }

    /// <summary>本地提示（工作台可见的零术语短句）。</summary>
    public List<string> Notices { get; } = [];

    /// <summary>技术日志（错误码、端点、pid；仅检视态可见）。</summary>
    public List<string> TechnicalLog { get; } = [];

    /// <summary>良知锁定正文（仅检视态渲染）。</summary>
    public string? ConscienceBody { get; set; }

    /// <summary>当前密度。</summary>
    public CognitionDensity Density => View.Density;

    /// <summary>当前降级说明。</summary>
    public DegradedView? Degraded => Connection.Degraded;

    /// <summary>幂等应用视图补丁。</summary>
    public void ApplyPatch(ViewPatch patch) => View.Apply(patch);

    /// <summary>切换密度：只推进一个纯密度补丁修订，绝不动任何行或会话状态。</summary>
    public bool SetDensity(CognitionDensity density)
    {
        if (View.Density == density)
        {
            return false;
        }

        View.Apply(View.DensityPatch(density));
        return true;
    }

    /// <summary>消费一批拉模式流事件（幂等：重复批次不会重复追加正文）。</summary>
    public StreamIngest IngestStream(IReadOnlyList<StreamEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);
        var ingest = new StreamIngest();
        foreach (var streamEvent in events)
        {
            // 序号 0 也是合法事件：用可空水位区分「尚未消费」与「已消费到 0」。
            if (Session.LastSeq is { } lastSeq && streamEvent.Seq <= lastSeq)
            {
                continue;
            }

            Session.LastSeq = streamEvent.Seq;

            ingest.Applied++;
            switch (streamEvent.Kind)
            {
                case StreamEventKind.Delta:
                    Session.Streaming = true;
                    Session.AppendAssistantDelta(streamEvent.Text);
                    ingest.Deltas += streamEvent.Text;
                    break;
                case StreamEventKind.Reasoning:
                    Session.Reasoning += streamEvent.Text;
                    break;
                case StreamEventKind.ToolCall:
                    Session.Messages.Add(new ChatLine(ChatRole.System, $"工具：{streamEvent.Text}"));
                    break;
                case StreamEventKind.Done:
                    Session.Streaming = false;
                    break;
                case StreamEventKind.Error:
                    Session.Streaming = false;
                    Session.Messages.Add(new ChatLine(ChatRole.System, $"出错了：{streamEvent.Text}"));
                    ingest.AddAnnouncement(new Announcement(
                        AnnouncementClass.Error,
                        $"本轮出错了：{streamEvent.Text}"));
                    break;
            }
        }

        if (!string.IsNullOrWhiteSpace(ingest.Deltas))
        {
            ingest.AddAnnouncement(new Announcement(AnnouncementClass.Delta, TailChars(ingest.Deltas, 80)));
        }

        return ingest;
    }

    /// <summary>追加用户消息（本地回显）。</summary>
    public void PushUserMessage(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        Session.Messages.Add(new ChatLine(ChatRole.User, text));
    }

    /// <summary>收束当前流（非流式回包同样走这条路径）。</summary>
    public void FinishStream() => Session.Streaming = false;

    /// <summary>记录一条本地提示（零术语，工作台可见）。</summary>
    public void Notice(string text) => Notices.Add(text);

    /// <summary>记录一条技术细节（仅检视态展示）。</summary>
    public void Technical(string text) => TechnicalLog.Add(text);

    /// <summary>按当前密度投影出指定种类的行。</summary>
    public IReadOnlyList<ViewRow> RowsOf(string kind) =>
        View.Project()
            .Where(row => string.Equals(row.Kind, kind, StringComparison.Ordinal)
                || string.Equals(row.Key, kind, StringComparison.Ordinal))
            .ToArray();

    /// <summary>最近一条助手消息。</summary>
    public string? LastAssistantText() =>
        Session.Messages.LastOrDefault(line => line.Role == ChatRole.Assistant)?.Text;

    private static string TailChars(string text, int limit)
    {
        var trimmed = text.Trim();
        return trimmed.Length <= limit ? trimmed : trimmed[^limit..];
    }
}
