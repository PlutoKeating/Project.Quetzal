namespace Quetzalcoatl.Interop;

/// <summary>Quetzalcoatl 家目录解析（与 AGENTS.md 的平台默认一致）。</summary>
public sealed record HomePaths(string Root)
{
    /// <summary>命令行走廊：显式参数 → <c>QUETZALCOATL_HOME</c> → <c>%LOCALAPPDATA%\Quetzalcoatl</c>。</summary>
    public static HomePaths Resolve(string? explicitHome = null)
    {
        if (!string.IsNullOrWhiteSpace(explicitHome))
        {
            return new HomePaths(Path.GetFullPath(explicitHome));
        }

        var fromEnv = Environment.GetEnvironmentVariable("QUETZALCOATL_HOME");
        if (!string.IsNullOrWhiteSpace(fromEnv))
        {
            return new HomePaths(Path.GetFullPath(fromEnv));
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return new HomePaths(Path.Combine(local, "Quetzalcoatl"));
    }

    /// <summary>守护进程运行时描述文件。</summary>
    public string RuntimeInfoPath => Path.Combine(Root, "run", "daemon.json");

    /// <summary>本地 IPC 令牌。</summary>
    public string TokenPath => Path.Combine(Root, "run", "daemon.token");

    /// <summary>脊柱独占锁（薄客户端只探测存在性，绝不打开脊柱）。</summary>
    public string SpineLockPath => Path.Combine(Root, "spine", "daemon.lock");

    /// <summary>桌面端偏好文件。</summary>
    public string PreferencesPath => Path.Combine(Root, "desktop.json");
}
