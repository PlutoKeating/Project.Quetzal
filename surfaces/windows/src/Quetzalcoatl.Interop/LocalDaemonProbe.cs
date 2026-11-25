namespace Quetzalcoatl.Interop;

using System.Text.Json;
using Quetzalcoatl.Desktop.Model;

/// <summary>一次连接探测的完整结果。</summary>
public sealed record RuntimeProbeResult(
    ConnectionState Connection,
    bool BindingsAvailable,
    bool TokenPresent,
    string Technical);

/// <summary>
/// 本机 <c>quetzalcoatld</c> 探测：只读 <c>run/daemon.json</c> 与 <c>run/daemon.token</c>
/// 的存在性/元数据，绝不打开脊柱（防坑规范 #13）。
/// <para>
/// Windows 没有 POSIX 权限位：令牌 ACL 由守护进程写入 <c>%LOCALAPPDATA%</c> 时继承
/// （与 Rust 侧 <c>#[cfg(not(unix))]</c> 的隐私检查保持同一语义），故这里不做额外 ACL 判定。
/// </para>
/// </summary>
public static class LocalDaemonProbe
{
    /// <summary>探测本机守护进程。</summary>
    public static RuntimeProbeResult Probe(HomePaths home, bool bindingsAvailable)
    {
        ArgumentNullException.ThrowIfNull(home);

        if (!File.Exists(home.RuntimeInfoPath))
        {
            return new RuntimeProbeResult(
                new ConnectionState.Offline(DegradedCopy.For(
                    DegradedReason.DaemonUnavailable,
                    $"缺少 {home.RuntimeInfoPath}")),
                bindingsAvailable,
                File.Exists(home.TokenPath),
                $"daemon.json 不存在: {home.RuntimeInfoPath}");
        }

        if (!File.Exists(home.TokenPath))
        {
            return new RuntimeProbeResult(
                new ConnectionState.Offline(DegradedCopy.For(
                    DegradedReason.DaemonUnavailable,
                    $"缺少 {home.TokenPath}")),
                bindingsAvailable,
                false,
                $"daemon.token 不存在: {home.TokenPath}");
        }

        string raw;
        try
        {
            raw = File.ReadAllText(home.RuntimeInfoPath);
        }
        catch (IOException error)
        {
            return OfflineTransport(bindingsAvailable, true, $"读取 daemon.json 失败: {error.Message}");
        }
        catch (UnauthorizedAccessException error)
        {
            return OfflineTransport(bindingsAvailable, true, $"读取 daemon.json 被拒绝: {error.Message}");
        }

        uint pid;
        string endpoint;
        try
        {
            using var document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            if (!root.TryGetProperty("pid", out var pidElement) || !pidElement.TryGetUInt32(out pid))
            {
                return OfflineTransport(bindingsAvailable, true, "daemon.json 缺少合法的 pid");
            }

            endpoint = root.TryGetProperty("ipc_http_addr", out var endpointElement)
                ? endpointElement.GetString() ?? "127.0.0.1:?"
                : "127.0.0.1:?";
        }
        catch (JsonException error)
        {
            return OfflineTransport(bindingsAvailable, true, $"解析 daemon.json 失败: {error.Message}");
        }

        if (!bindingsAvailable)
        {
            return new RuntimeProbeResult(
                new ConnectionState.Offline(DegradedCopy.For(
                    DegradedReason.BindingsUnavailable,
                    "未链接 quetzalcoatl_uniffi 原生库；以默认构建打开时无法建立拉模式流")),
                false,
                true,
                "本构建未定义 QZ_UNIFFI_BINDINGS");
        }

        return new RuntimeProbeResult(
            new ConnectionState.Online(pid, endpoint, 0),
            true,
            true,
            $"已发现本机守护进程 pid={pid} endpoint={endpoint}");
    }

    private static RuntimeProbeResult OfflineTransport(bool bindingsAvailable, bool tokenPresent, string technical) =>
        new(
            new ConnectionState.Offline(DegradedCopy.For(DegradedReason.IpcTransport, technical)),
            bindingsAvailable,
            tokenPresent,
            technical);
}
