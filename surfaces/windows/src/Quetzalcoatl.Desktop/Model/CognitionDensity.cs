namespace Quetzalcoatl.Desktop.Model;

/// <summary>视图披露层级（严格嵌套：<see cref="Summary"/> ⊂ <see cref="Detail"/> ⊂ <see cref="Raw"/>）。</summary>
public enum DetailLayer
{
    /// <summary>一句话摘要，陪伴态可见。</summary>
    Summary,

    /// <summary>可操作细节，工作台及以上可见。</summary>
    Detail,

    /// <summary>原始载荷（JSON、错误码、事件序号），仅检视态可见。</summary>
    Raw,
}

/// <summary>三档认知密度。</summary>
public enum CognitionDensity
{
    /// <summary>陪伴态：零术语、≥64px 触点。</summary>
    Companion,

    /// <summary>工作台态：摘要 + 细节，桌面默认。</summary>
    Workbench,

    /// <summary>检视态：摘要 + 细节 + 原始载荷。</summary>
    Inspector,
}

/// <summary>密度相关的纯函数投影规则（与 Rust <c>CognitionDensity</c> 一一对应）。</summary>
public static class CognitionDensityExtensions
{
    /// <summary>该密度是否允许披露指定层级。</summary>
    public static bool Includes(this CognitionDensity density, DetailLayer layer) => layer switch
    {
        DetailLayer.Summary => true,
        DetailLayer.Detail => density != CognitionDensity.Companion,
        DetailLayer.Raw => density == CognitionDensity.Inspector,
        _ => false,
    };

    /// <summary>稳定的英文标识（配置文件、自动化 ID 使用）。</summary>
    public static string Label(this CognitionDensity density) => density switch
    {
        CognitionDensity.Companion => "companion",
        CognitionDensity.Workbench => "workbench",
        CognitionDensity.Inspector => "inspector",
        _ => "workbench",
    };

    /// <summary>面向人的页面标题。</summary>
    public static string Title(this CognitionDensity density) => density switch
    {
        CognitionDensity.Companion => "陪伴",
        CognitionDensity.Workbench => "工作台",
        CognitionDensity.Inspector => "检视",
        _ => "工作台",
    };

    /// <summary>窗口标题。</summary>
    public static string WindowTitle(this CognitionDensity density) => $"Quetzalcoatl · {density.Title()}";

    /// <summary>键盘加速键文案（与 XAML <c>KeyboardAccelerator</c> 一致）。</summary>
    public static string Accelerator(this CognitionDensity density) => density switch
    {
        CognitionDensity.Companion => "Ctrl+1",
        CognitionDensity.Workbench => "Ctrl+2",
        CognitionDensity.Inspector => "Ctrl+3",
        _ => "Ctrl+2",
    };
}
