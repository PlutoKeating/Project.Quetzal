namespace Quetzalcoatl.Desktop.Tests;

using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Settings;

/// <summary>偏好持久化：原子写、损坏回退、尺寸收敛。</summary>
public sealed class PreferencesTests
{
    private static string TempPath() =>
        Path.Combine(Path.GetTempPath(), $"qz-win-pref-{Guid.NewGuid():N}", "desktop.json");

    [Fact]
    public void RoundTripsDensityAndSize()
    {
        var path = TempPath();
        try
        {
            var store = new PreferencesStore(path);
            store.Save(new DesktopPreferences
            {
                Density = CognitionDensity.Inspector,
                Width = 1440,
                Height = 900,
                Maximized = true,
                CloseToTray = false,
                StartAtLogin = true,
            });

            var loaded = store.Load();
            Assert.Equal(CognitionDensity.Inspector, loaded.Density);
            Assert.Equal(1440, loaded.Width);
            Assert.Equal(900, loaded.Height);
            Assert.True(loaded.Maximized);
            Assert.False(loaded.CloseToTray);
            Assert.True(loaded.StartAtLogin);
            Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.tmp"));
        }
        finally
        {
            var directory = Path.GetDirectoryName(path);
            if (directory is not null && Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
    }

    [Fact]
    public void CorruptFileFallsBackToDefaults()
    {
        var path = TempPath();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, "{ not json");
            var loaded = new PreferencesStore(path).Load();
            Assert.Equal(new DesktopPreferences(), loaded);
        }
        finally
        {
            var directory = Path.GetDirectoryName(path);
            if (directory is not null && Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
    }

    [Fact]
    public void SizesAreClamped()
    {
        var sanitized = new DesktopPreferences { Width = 10, Height = 100_000 }.Sanitized();
        Assert.Equal(320, sanitized.Width);
        Assert.Equal(16384, sanitized.Height);
    }
}
