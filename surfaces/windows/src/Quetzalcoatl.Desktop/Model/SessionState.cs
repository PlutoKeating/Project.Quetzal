namespace Quetzalcoatl.Desktop.Model;

/// <summary>会话内一条消息的角色。</summary>
public enum ChatRole
{
    /// <summary>用户。</summary>
    User,

    /// <summary>助手（流式增量并入最后一条助手消息）。</summary>
    Assistant,

    /// <summary>系统/工具/错误提示。</summary>
    System,
}

/// <summary>会话内一条消息。</summary>
public sealed record ChatLine(ChatRole Role, string Text);

/// <summary>当前会话与流状态（跨密度切换保持不变）。</summary>
public sealed class SessionState
{
    /// <summary>线程标识（合成数据或守护进程返回值）。</summary>
    public string ThreadId { get; set; } = "local";

    /// <summary>线程标题。</summary>
    public string Title { get; set; } = "当前会话";

    /// <summary>已发生的消息。</summary>
    public List<ChatLine> Messages { get; } = [];

    /// <summary>推理增量（检视态可见）。</summary>
    public string Reasoning { get; set; } = string.Empty;

    /// <summary>是否正在流式接收。</summary>
    public bool Streaming { get; set; }

    /// <summary>已消费的最大事件序号（幂等去重）。</summary>
    public ulong LastSeq { get; set; }

    /// <summary>面向人的完整对话文本（陪伴态直接展示）。</summary>
    public string Transcript() => string.Join(
        "\n\n",
        Messages.Select(line => line.Role switch
        {
            ChatRole.User => $"你：{line.Text}",
            ChatRole.System => $"· {line.Text}",
            _ => line.Text,
        }));

    /// <summary>追加一段助手正文增量（并入最后一条助手消息）。</summary>
    public void AppendAssistantDelta(string text)
    {
        if (Messages.Count > 0 && Messages[^1].Role == ChatRole.Assistant)
        {
            Messages[^1] = Messages[^1] with { Text = Messages[^1].Text + text };
            return;
        }

        Messages.Add(new ChatLine(ChatRole.Assistant, text));
    }
}

/// <summary>与 <c>quetzalcoatld</c> 的连接状态（类型化，不在视图层解析字符串）。</summary>
public abstract record ConnectionState
{
    private ConnectionState()
    {
    }

    /// <summary>是否已通过本地认证通道连上守护进程。</summary>
    public bool IsOnline => this is Online;

    /// <summary>在线：守护进程标识与脊柱事件数。</summary>
    public sealed record Online(uint Pid, string Endpoint, int SpineEvents) : ConnectionState;

    /// <summary>不可达/不安全/被拒；携带面向人的说明。</summary>
    public sealed record Offline(DegradedView View) : ConnectionState;

    /// <summary>降级说明（在线时为 <c>null</c>）。</summary>
    public DegradedView? Degraded => (this as Offline)?.View;
}
