namespace Quetzalcoatl.App.Views;

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;

/// <summary>工作台态：会话、工作流、审批与消息输入。</summary>
public sealed partial class WorkbenchView : UserControl
{
    /// <summary>用户提交一句话。</summary>
    public event EventHandler<string>? MessageSubmitted;

    /// <summary>用户对待批准操作作出决定（true = 批准）。</summary>
    public event EventHandler<ApprovalDecision>? ApprovalDecided;

    public WorkbenchView() => InitializeComponent();

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

    private void OnApproveClick(object sender, RoutedEventArgs e) => Decide(sender, approved: true);

    private void OnDenyClick(object sender, RoutedEventArgs e) => Decide(sender, approved: false);

    private void Decide(object sender, bool approved)
    {
        var key = (sender as FrameworkElement)?.Tag as string ?? string.Empty;
        ApprovalDecided?.Invoke(this, new ApprovalDecision(key, approved));
    }
}

/// <summary>一次审批决定（key + 是否批准）。</summary>
public sealed record ApprovalDecision(string Key, bool Approved);
