namespace Quetzalcoatl.Desktop.Model;

/// <summary>流事件类别（与 UniFFI <c>FfiStreamEvent.kind</c> 字符串一一对应）。</summary>
public enum StreamEventKind
{
    /// <summary>增量正文 token。</summary>
    Delta,

    /// <summary>推理/思考增量。</summary>
    Reasoning,

    /// <summary>工具调用片段。</summary>
    ToolCall,

    /// <summary>本轮流结束。</summary>
    Done,

    /// <summary>上游或本地错误。</summary>
    Error,
}

/// <summary>一个拉模式流事件。</summary>
public sealed record StreamEvent(ulong Seq, StreamEventKind Kind, string Text)
{
    /// <summary>把 UniFFI 的字符串类别解析为类型化枚举；未知类别显式失败。</summary>
    public static StreamEventKind ParseKind(string label) => label switch
    {
        "delta" => StreamEventKind.Delta,
        "reasoning" => StreamEventKind.Reasoning,
        "tool_call" => StreamEventKind.ToolCall,
        "done" => StreamEventKind.Done,
        "error" => StreamEventKind.Error,
        _ => throw new ArgumentOutOfRangeException(nameof(label), label, "未知的流事件类别"),
    };
}

/// <summary>播报类别：错误/审批类优先级高于普通正文增量。</summary>
public enum AnnouncementClass
{
    /// <summary>正文增量。</summary>
    Delta,

    /// <summary>上游/本地错误。</summary>
    Error,

    /// <summary>审批类提示。</summary>
    Approval,
}

/// <summary>一条待播报文本。</summary>
public sealed record Announcement(AnnouncementClass Class, string Text);

/// <summary>一次流事件批次的消费结果。</summary>
public sealed class StreamIngest
{
    private readonly List<Announcement> _announcements = [];

    /// <summary>实际消费的事件数（被幂等去重的旧事件不计）。</summary>
    public int Applied { get; internal set; }

    /// <summary>本批新增的正文增量。</summary>
    public string Deltas { get; internal set; } = string.Empty;

    /// <summary>本批产生的播报候选（顺序 = 事件顺序）。</summary>
    public IReadOnlyList<Announcement> Announcements => _announcements;

    internal void AddAnnouncement(Announcement announcement) => _announcements.Add(announcement);

    /// <summary>
    /// 每批只播一条：错误/审批类永远压过正文增量；同类别取最后一条。
    /// </summary>
    public string? PreferredAnnouncement() =>
        _announcements
            .AsEnumerable()
            .Reverse()
            .FirstOrDefault(item => item.Class is AnnouncementClass.Error or AnnouncementClass.Approval)
            ?.Text
        ?? _announcements.LastOrDefault()?.Text;
}
