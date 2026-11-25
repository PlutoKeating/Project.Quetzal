namespace Quetzalcoatl.App.Services;

using Microsoft.Win32;

/// <summary>
/// 登录自启（Windows 上等价 Linux 用户级 systemd unit / macOS LaunchAgent 的生命周期挂钩）。
/// 仅写当前用户 <c>HKCU\…\Run</c>，不需要管理员权限；失败返回 false，绝不静默假装成功。
/// </summary>
public static class LoginStartup
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "QuetzalcoatlDesktop";

    /// <summary>是否已启用登录自启。</summary>
    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
            return key?.GetValue(ValueName) is string value && !string.IsNullOrWhiteSpace(value);
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>启用登录自启（写入带引号的可执行路径）。</summary>
    public static bool Enable(string executablePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(executablePath);
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
            if (key is null)
            {
                return false;
            }

            key.SetValue(ValueName, $"\"{executablePath}\" --minimized", RegistryValueKind.String);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>关闭登录自启。</summary>
    public static bool Disable()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            if (key is null)
            {
                return true;
            }

            if (key.GetValue(ValueName) is not null)
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }

            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
