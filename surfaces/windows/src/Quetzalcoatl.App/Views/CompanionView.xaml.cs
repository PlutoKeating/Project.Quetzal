namespace Quetzalcoatl.App.Views;

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;

/// <summary>陪伴态：零术语、≥64px 触点、流式对话正文。</summary>
public sealed partial class CompanionView : UserControl
{
    /// <summary>用户提交一句话。</summary>
    public event EventHandler<string>? MessageSubmitted;

    /// <summary>用户请求重新连接本机助手。</summary>
    public event EventHandler? RetryRequested;

    public CompanionView() => InitializeComponent();

    private void Submit()
    {
        var text = ComposerBox.Text;
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        ComposerBox.Text = string.Empty;
        MessageSubmitted?.Invoke(this, text);
    }

    private void OnSendClick(object sender, RoutedEventArgs e) => Submit();

    private void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter)
        {
            return;
        }

        Submit();
        e.Handled = true;
    }

    private void OnRetryClick(object sender, RoutedEventArgs e) => RetryRequested?.Invoke(this, EventArgs.Empty);
}
