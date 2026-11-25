namespace Quetzalcoatl.Desktop.Settings;

using System.Text.Json;
using System.Text.Json.Serialization;
using Quetzalcoatl.Desktop.Model;

/// <summary>桌面端持久偏好（密度、窗口尺寸、托盘与登录启动）。</summary>
public sealed record DesktopPreferences
{
    /// <summary>上次选择的认知密度。</summary>
    [JsonConverter(typeof(JsonStringEnumConverter<CognitionDensity>))]
    public CognitionDensity Density { get; init; } = CognitionDensity.Workbench;

    /// <summary>窗口宽度（逻辑像素）。</summary>
    public int Width { get; init; } = 1180;

    /// <summary>窗口高度（逻辑像素）。</summary>
    public int Height { get; init; } = 780;

    /// <summary>上次是否最大化。</summary>
    public bool Maximized { get; init; }

    /// <summary>关闭主窗口时是否驻留托盘。</summary>
    public bool CloseToTray { get; init; } = true;

    /// <summary>是否随登录启动（由计划任务实现，等价 Linux 用户级 unit / macOS LaunchAgent）。</summary>
    public bool StartAtLogin { get; init; }

    /// <summary>把明显非法的尺寸收敛到可用范围。</summary>
    public DesktopPreferences Sanitized() => this with
    {
        Width = Math.Clamp(Width, 320, 16384),
        Height = Math.Clamp(Height, 240, 16384),
    };
}

/// <summary>偏好的原子读写（同目录临时文件 + 替换；损坏或缺失整体回退默认值）。</summary>
public sealed class PreferencesStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly string _path;

    /// <summary>以偏好文件路径构造。</summary>
    public PreferencesStore(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        _path = path;
    }

    /// <summary>偏好文件路径。</summary>
    public string Path => _path;

    /// <summary>读取偏好；缺失、损坏或字段非法时整体回退默认值。</summary>
    public DesktopPreferences Load()
    {
        try
        {
            if (!File.Exists(_path))
            {
                return new DesktopPreferences();
            }

            var json = File.ReadAllText(_path);
            var parsed = JsonSerializer.Deserialize<DesktopPreferences>(json, Options);
            return (parsed ?? new DesktopPreferences()).Sanitized();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return new DesktopPreferences();
        }
    }

    /// <summary>原子写盘（临时文件与目标同目录，避免跨卷替换）。</summary>
    public void Save(DesktopPreferences preferences)
    {
        ArgumentNullException.ThrowIfNull(preferences);
        var directory = System.IO.Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var sanitized = preferences.Sanitized();
        var temp = $"{_path}.{Environment.ProcessId}.tmp";
        var json = JsonSerializer.Serialize(sanitized, Options);
        File.WriteAllText(temp, json);
        File.Move(temp, _path, overwrite: true);
    }
}
