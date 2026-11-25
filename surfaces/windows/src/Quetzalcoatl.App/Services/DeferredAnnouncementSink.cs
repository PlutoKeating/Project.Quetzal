namespace Quetzalcoatl.App.Services;

using Quetzalcoatl.Desktop.ViewModels;

/// <summary>
/// 延迟接线的实时播报出口：视图模型先于窗口创建，窗口加载后再把播报接到
/// 真实 UI Automation 通知通道（等价 <c>aria-live</c> + 显式播报）。
/// </summary>
public sealed class DeferredAnnouncementSink : IAnnouncementSink
{
    private Action<string>? _target;

    /// <summary>接上真实播报实现（窗口初始化后调用一次）。</summary>
    public void Attach(Action<string> target)
    {
        ArgumentNullException.ThrowIfNull(target);
        _target = target;
    }

    /// <inheritdoc />
    public void Announce(string text) => _target?.Invoke(text);
}
