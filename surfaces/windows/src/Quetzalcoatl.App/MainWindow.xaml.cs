namespace Quetzalcoatl.App;

using System.ComponentModel;
using System.Diagnostics;
using Microsoft.UI.Xaml;

/// <summary>最小治理外壳：说明治理面在哪里，并提供一个打开本机治理面的按钮。</summary>
public sealed partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Title = "Quetzalcoatl";
    }

    private void OnOpenGovernance(object sender, RoutedEventArgs e)
    {
        _ = sender;
        _ = e;
        StatusText.Text = TryRunQzOpen()
            ? "已请求打开本机治理面。"
            : "没有找到 qz 命令；请在终端运行 qz open。";
    }

    private static bool TryRunQzOpen()
    {
        try
        {
            var start = new ProcessStartInfo("qz", "open")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var process = Process.Start(start);
            return process is not null;
        }
        catch (Win32Exception)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
