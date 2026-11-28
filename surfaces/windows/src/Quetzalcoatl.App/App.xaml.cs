namespace Quetzalcoatl.App;

using Microsoft.UI.Xaml;

/// <summary>应用入口：只创建一个说明窗口，没有对话、输入框或后台流。</summary>
public partial class App : Application
{
    private MainWindow? _window;

    public App()
    {
        InitializeComponent();
    }

    /// <inheritdoc />
    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _ = args;
        _window = new MainWindow();
        _window.Activate();
    }
}
