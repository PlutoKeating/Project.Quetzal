namespace Quetzalcoatl.Desktop.ViewModels;

using Quetzalcoatl.Desktop.Model;

/// <summary>可观测的实时播报出口（界面接线到 <c>AutomationPeer.RaiseNotificationEvent</c>）。</summary>
public interface IAnnouncementSink
{
    /// <summary>播报一段文本（一次调用 = 一次播报）。</summary>
    void Announce(string text);
}

/// <summary>
/// 每批流事件只播报一次：错误/审批优先；空批次不播报。
/// 计数与最近文本对外开放，测试据此断言「每批恰好一次、绝不结巴」。
/// </summary>
public sealed class StreamingAnnouncer
{
    private readonly IAnnouncementSink _sink;

    /// <summary>构造播报器。</summary>
    public StreamingAnnouncer(IAnnouncementSink sink)
    {
        ArgumentNullException.ThrowIfNull(sink);
        _sink = sink;
    }

    /// <summary>已发生的播报次数。</summary>
    public int AnnouncementCount { get; private set; }

    /// <summary>最近一次播报文本。</summary>
    public string? LastAnnouncement { get; private set; }

    /// <summary>对一批消费结果播报恰好一次；没有候选时不播报。返回是否播报。</summary>
    public bool AnnounceOnce(StreamIngest ingest)
    {
        ArgumentNullException.ThrowIfNull(ingest);
        var text = ingest.PreferredAnnouncement();
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        LastAnnouncement = text;
        AnnouncementCount++;
        _sink.Announce(text);
        return true;
    }
}

/// <summary>陪伴态的全部用户可见文案（单一来源，供零术语审计与 XAML 绑定使用）。</summary>
public static class CompanionCopy
{
    /// <summary>在线时的标题。</summary>
    public const string HeadingOnline = "今天想聊点什么？";

    /// <summary>离线时的标题。</summary>
    public const string HeadingOffline = "我还没连上本机的助手";

    /// <summary>在线且无对话时的引导。</summary>
    public const string EmptyOnline = "我在这儿。想说什么都可以。";

    /// <summary>离线且无对话时的说明。</summary>
    public const string EmptyOffline = "助手启动后，我们刚才聊到哪儿都会接上。";

    /// <summary>在线状态。</summary>
    public const string StatusOnline = "已连接";

    /// <summary>流式进行中。</summary>
    public const string StatusStreaming = "正在回复…";

    /// <summary>离线状态。</summary>
    public const string StatusOffline = "已断开";

    /// <summary>重连按钮。</summary>
    public const string RetryLabel = "重新连接";

    /// <summary>发送按钮。</summary>
    public const string SendLabel = "发送";

    /// <summary>输入框占位。</summary>
    public const string EntryPlaceholder = "想说什么都行";

    /// <summary>对话区无障碍名称。</summary>
    public const string TranscriptLabel = "对话内容";

    /// <summary>对话区无障碍描述。</summary>
    public const string TranscriptDescription = "对话会持续更新，新的回复会自动播报";

    /// <summary>离线时发消息的本地提示。</summary>
    public const string OfflineSendNotice = "还没连上本机助手，这句话只留在本机窗口里，不会被发送。";

    /// <summary>离线且无连接组件时的提示。</summary>
    public const string BindingsUnavailableNotice = "这个版本缺少连接本机助手的组件，界面部分仍可正常使用。";

    /// <summary>所有陪伴态用户可见文案（零术语审计的输入集合）。</summary>
    public static IReadOnlyList<string> All { get; } =
    [
        HeadingOnline,
        HeadingOffline,
        EmptyOnline,
        EmptyOffline,
        StatusOnline,
        StatusStreaming,
        StatusOffline,
        RetryLabel,
        SendLabel,
        EntryPlaceholder,
        TranscriptLabel,
        TranscriptDescription,
        OfflineSendNotice,
        BindingsUnavailableNotice,
    ];
}
