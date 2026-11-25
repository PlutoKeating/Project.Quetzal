namespace Quetzalcoatl.App.Services;

using System.Runtime.CompilerServices;
using System.Text;

/// <summary>
/// 启动期崩溃取证：WinExe 没有控制台，XAML/WinRT 初始化异常会以 stowed exception 结束进程；
/// 模块初始化器在任何托管代码之前挂上处理器，把完整异常写进 <c>%TEMP%</c> 便于定位。
/// </summary>
internal static class StartupDiagnostics
{
    private static readonly object Gate = new();

    /// <summary>诊断文件路径（仅崩溃时写入）。</summary>
    internal static string ReportPath =>
        Path.Combine(Path.GetTempPath(), "quetzalcoatl-win-startup-error.txt");

    [ModuleInitializer]
    internal static void Install()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, args) => Write("AppDomain.UnhandledException", args.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, args) => Write("TaskScheduler.UnobservedTaskException", args.Exception);
    }

    /// <summary>记录一次启动/初始化失败。</summary>
    internal static void Write(string stage, Exception? error)
    {
        try
        {
            lock (Gate)
            {
                var payload = new StringBuilder()
                    .Append('[').Append(DateTimeOffset.Now.ToString("O")).Append("] ")
                    .Append(stage).AppendLine()
                    .AppendLine(error?.ToString() ?? "(no exception object)")
                    .ToString();
                File.AppendAllText(ReportPath, payload, Encoding.UTF8);
            }
        }
        catch (Exception)
        {
            // 取证失败绝不覆盖原始错误。
        }
    }
}
