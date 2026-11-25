namespace Quetzalcoatl.Desktop.Tests;

using System.Reflection;

/// <summary>测试用仓库路径解析（不依赖当前工作目录）。</summary>
internal static class RepoPaths
{
    public static string SurfacesRoot
    {
        get
        {
            var value = typeof(RepoPaths).Assembly
                .GetCustomAttributes<AssemblyMetadataAttribute>()
                .FirstOrDefault(attribute => attribute.Key == "SurfacesRoot")?.Value;
            Assert.False(string.IsNullOrWhiteSpace(value), "测试工程缺少 SurfacesRoot 元数据");
            return Path.GetFullPath(value!);
        }
    }

    public static string XamlPath(string relative) => Path.Combine(SurfacesRoot, relative);
}
