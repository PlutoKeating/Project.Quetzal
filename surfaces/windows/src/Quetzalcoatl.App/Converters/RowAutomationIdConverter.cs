namespace Quetzalcoatl.App.Converters;

using Microsoft.UI.Xaml.Data;

/// <summary>
/// 为模板内的行级按钮生成唯一 AutomationId：<c>参数/行 key</c>。
/// 契约里的 <c>workbench.approve</c> 是前缀，真实 UIA 树中必须是 <c>workbench.approve/session:a</c> 这类唯一值。
/// </summary>
public sealed partial class RowAutomationIdConverter : IValueConverter
{
    /// <inheritdoc />
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        var prefix = parameter as string ?? "row";
        var key = value as string ?? string.Empty;
        return string.IsNullOrEmpty(key) ? prefix : $"{prefix}/{key}";
    }

    /// <inheritdoc />
    public object ConvertBack(object value, Type targetType, object parameter, string language) =>
        throw new NotSupportedException("AutomationId 是只读投影");
}
