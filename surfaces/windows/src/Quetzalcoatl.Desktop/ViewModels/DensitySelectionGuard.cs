namespace Quetzalcoatl.Desktop.ViewModels;

/// <summary>
/// 启动期密度选择守卫：`TabView.SelectionChanged` 在加载布局时会以默认索引触发一次，
/// 若不屏蔽，已保存的 `.inspector` 会在启动瞬间被覆写成 `.companion`。
/// 该类型把「初始化阶段忽略选择事件」的规则变成可单测的纯逻辑。
/// </summary>
public sealed class DensitySelectionGuard
{
    private bool _initializing = true;

    /// <summary>是否仍处于初始化阶段（此时的选择事件必须忽略）。</summary>
    public bool IsInitializing => _initializing;

    /// <summary>是否应当应用这次用户选择。</summary>
    public bool ShouldApplySelection => !_initializing;

    /// <summary>初始 `SelectedIndex` 赋值完成后调用一次。</summary>
    public void CompleteInitialization() => _initializing = false;
}
