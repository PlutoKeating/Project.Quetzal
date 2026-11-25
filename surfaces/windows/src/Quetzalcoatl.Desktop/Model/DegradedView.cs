namespace Quetzalcoatl.Desktop.Model;

/// <summary>客户端连接守护进程失败的类型化原因。</summary>
public enum DegradedReason
{
    /// <summary>本机守护进程未运行，运行时文件缺失。</summary>
    DaemonUnavailable,

    /// <summary>运行时凭证权限过宽，已主动拒绝连接。</summary>
    InsecureRuntimeFiles,

    /// <summary>本地传输层无响应或断开。</summary>
    IpcTransport,

    /// <summary>守护进程返回了拒绝应答。</summary>
    IpcRemote,

    /// <summary>这个构建没有链接本机连接组件（UniFFI 原生库缺失）。</summary>
    BindingsUnavailable,

    /// <summary>发现运行时文件，但令牌认证/状态握手未通过。</summary>
    DetectedUnverified,
}

/// <summary>一段给用户看的降级说明（标题 + 一句解释 + 一个动作 + 技术原因）。</summary>
public sealed record DegradedView(string Title, string Detail, string Hint, string Technical)
{
    /// <summary>供检视态单行展示的技术摘要。</summary>
    public string TechnicalLine => string.IsNullOrEmpty(Technical) ? Detail : Technical;
}

/// <summary>类型化错误的零术语文案表。</summary>
public static class DegradedCopy
{
    /// <summary>把类型化原因翻译为面向人的说明。</summary>
    public static DegradedView For(DegradedReason reason, string technical) => reason switch
    {
        DegradedReason.DaemonUnavailable => new DegradedView(
            "本机的 Quetzalcoatl 助手还没启动",
            "这个窗口已经准备好了，只是暂时联系不上本机的助手。",
            "在终端运行 quetzalcoatld，然后点下面的「重新连接」。",
            technical),
        DegradedReason.InsecureRuntimeFiles => new DegradedView(
            "助手的运行凭证权限不安全，已主动拒绝连接",
            "为了保护你的数据，助手在凭证权限过宽时不会接受任何连接。",
            "只允许你自己的账户读取运行凭证文件，然后重试。",
            technical),
        DegradedReason.IpcTransport => new DegradedView(
            "本机助手暂时没有响应",
            "助手可能正在重启，稍等一下再试就好。",
            "点「重新连接」；如果一直这样，请重启 quetzalcoatld。",
            technical),
        DegradedReason.IpcRemote => new DegradedView(
            "本机助手拒绝了这次请求",
            "助手没有接受这次操作，你的原有数据没有变化。",
            "确认操作对象后重试；也可以在「检视」里查看原因。",
            technical),
        DegradedReason.BindingsUnavailable => new DegradedView(
            "这个版本还连不上本机助手",
            "安装的版本里缺少与本机助手通讯的组件，界面本身可以正常使用。",
            "安装完整版本后重新打开就可以连接。",
            technical),
        DegradedReason.DetectedUnverified => new DegradedView(
            "找到了本机助手，但还没通过验证",
            "运行时文件还在，但握手没有成功；你的数据没有被改动。",
            "点「重新连接」；如果一直这样，请重启 quetzalcoatld。",
            technical),
        _ => new DegradedView(
            "本机的 Quetzalcoatl 助手还没启动",
            "这个窗口已经准备好了，只是暂时联系不上本机的助手。",
            "在终端运行 quetzalcoatld，然后点下面的「重新连接」。",
            technical),
    };
}
