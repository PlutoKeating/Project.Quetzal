namespace Quetzalcoatl.Interop;

using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Quetzalcoatl.Desktop.Model;

/// <summary>本机守护进程 <c>status</c> 握手的应答（只保留桌面端需要的字段）。</summary>
public sealed record DaemonStatusReply(uint Pid, int SpineEvents);

/// <summary>
/// 守护进程状态握手传输层：默认实现走本机回环 HTTP（<c>POST /v1/rpc</c> +
/// <c>x-qz-ipc-token</c>）；测试可注入桩以覆盖成功路径。
/// </summary>
public interface IStatusTransport
{
    /// <summary>执行一次带令牌的 <c>status</c> 调用；任何失败返回 <c>null</c>。</summary>
    DaemonStatusReply? Fetch(string endpoint, string token);
}

/// <summary>一次连接探测的完整结果。</summary>
public sealed record RuntimeProbeResult(
    ConnectionState Connection,
    bool BindingsAvailable,
    bool TokenPresent,
    string Technical);

/// <summary>
/// 本机 <c>quetzalcoatld</c> 探测：只读 <c>run/daemon.json</c> + 权限校验后的
/// <c>run/daemon.token</c>，随后**必须**完成令牌认证的 <c>status</c> 握手才会报告在线；
/// 绝不打开脊柱（防坑规范 #13），也绝不因为「文件存在」就宣称已连接。
/// <para>
/// Windows 没有 POSIX 权限位：令牌 ACL 由守护进程写入 <c>%LOCALAPPDATA%</c> 时继承
/// （与 Rust 侧 <c>#[cfg(not(unix))]</c> 的隐私检查保持同一语义），故这里做令牌格式校验
/// 而不是 ACL 判定。
/// </para>
/// </summary>
public static class LocalDaemonProbe
{
    private const int TokenHexLength = 64;

    /// <summary>探测本机守护进程。</summary>
    public static RuntimeProbeResult Probe(
        HomePaths home,
        bool bindingsAvailable,
        IStatusTransport? transport = null)
    {
        ArgumentNullException.ThrowIfNull(home);

        if (!File.Exists(home.RuntimeInfoPath))
        {
            return Offline(
                DegradedReason.DaemonUnavailable,
                bindingsAvailable,
                File.Exists(home.TokenPath),
                $"daemon.json 不存在: {home.RuntimeInfoPath}");
        }

        if (!File.Exists(home.TokenPath))
        {
            return Offline(
                DegradedReason.DaemonUnavailable,
                bindingsAvailable,
                false,
                $"daemon.token 不存在: {home.TokenPath}");
        }

        string rawToken;
        try
        {
            rawToken = File.ReadAllText(home.TokenPath).Trim();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return Unverified(0, "?", bindingsAvailable, $"读取令牌失败: {error.Message}");
        }

        if (rawToken.Length != TokenHexLength || !rawToken.All(char.IsAsciiHexDigit))
        {
            return Unverified(0, "?", bindingsAvailable, "IPC 令牌格式非法（应为 64 位十六进制）");
        }

        string raw;
        try
        {
            raw = File.ReadAllText(home.RuntimeInfoPath);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return Offline(
                DegradedReason.IpcTransport,
                bindingsAvailable,
                true,
                $"读取 daemon.json 失败: {error.Message}");
        }

        uint pid;
        string endpoint;
        try
        {
            using var document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            if (!root.TryGetProperty("pid", out var pidElement) || !pidElement.TryGetUInt32(out pid))
            {
                return Offline(DegradedReason.IpcTransport, bindingsAvailable, true, "daemon.json 缺少合法的 pid");
            }

            endpoint = root.TryGetProperty("ipc_http_addr", out var endpointElement)
                ? endpointElement.GetString() ?? "127.0.0.1:?"
                : "127.0.0.1:?";
        }
        catch (JsonException error)
        {
            return Offline(
                DegradedReason.IpcTransport,
                bindingsAvailable,
                true,
                $"解析 daemon.json 失败: {error.Message}");
        }

        if (!bindingsAvailable)
        {
            // 本构建没有原生传输：即使守护进程在线也无法建立拉模式流，如实报告而不是假装已连接。
            return Offline(
                DegradedReason.BindingsUnavailable,
                false,
                true,
                "未链接 quetzalcoatl_uniffi 原生库；以默认构建打开时无法建立拉模式流");
        }

        if (!IsProcessAlive(pid))
        {
            return Unverified(pid, endpoint, true, $"daemon.json 的 pid={pid} 已退出（陈旧运行时文件）");
        }

        var reply = (transport ?? HttpStatusTransport.Instance).Fetch(endpoint, rawToken);
        if (reply is null)
        {
            return Unverified(pid, endpoint, true, $"令牌认证的 status 握手失败（{endpoint}）");
        }

        if (reply.Pid != pid)
        {
            return Unverified(pid, endpoint, true, $"status 返回的 pid={reply.Pid} 与 daemon.json 的 pid={pid} 不一致");
        }

        return new RuntimeProbeResult(
            new ConnectionState.Online(pid, endpoint, reply.SpineEvents),
            true,
            true,
            $"已通过令牌认证握手：pid={pid} endpoint={endpoint} spine_events={reply.SpineEvents}");
    }

    /// <summary>
    /// 判定探测 pid 存活时遇到的异常是否等价于「进程不存在/不可访问」。
    /// 受保护或已复用 pid 的 <see cref="Process.HasExited"/> 会抛 <see cref="Win32Exception"/>，
    /// 必须当作不存活处理，绝不能让异常逃逸到 <c>App.Boot</c>。
    /// </summary>
    public static bool IsNotAliveError(Exception error) =>
        error is ArgumentException or InvalidOperationException or Win32Exception;

    /// <summary>进程是否存活（pid=0、已退出、受保护/已复用 pid 均返回 false）。</summary>
    public static bool IsProcessAlive(uint pid)
    {
        if (pid == 0)
        {
            return false;
        }

        try
        {
            using var process = Process.GetProcessById((int)pid);
            return !process.HasExited;
        }
        catch (Exception error) when (IsNotAliveError(error))
        {
            return false;
        }
    }

    private static RuntimeProbeResult Offline(
        DegradedReason reason,
        bool bindingsAvailable,
        bool tokenPresent,
        string technical) =>
        new(
            new ConnectionState.Offline(DegradedCopy.For(reason, technical)),
            bindingsAvailable,
            tokenPresent,
            technical);

    private static RuntimeProbeResult Unverified(uint pid, string endpoint, bool bindingsAvailable, string technical) =>
        new(
            new ConnectionState.DetectedUnverified(pid, endpoint, technical),
            bindingsAvailable,
            true,
            technical);

    /// <summary>默认传输：本机回环 HTTP 的令牌认证 <c>status</c> 调用，2s 超时。</summary>
    private sealed class HttpStatusTransport : IStatusTransport
    {
        internal static readonly HttpStatusTransport Instance = new();

        private static readonly HttpClient Client = new()
        {
            Timeout = TimeSpan.FromSeconds(2),
        };

        public DaemonStatusReply? Fetch(string endpoint, string token)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, $"http://{endpoint}/v1/rpc");
                request.Headers.TryAddWithoutValidation("x-qz-ipc-token", token);
                request.Content = new StringContent("{\"method\":\"status\"}", Encoding.UTF8, "application/json");
                using var response = Client.Send(request);
                if (!response.IsSuccessStatusCode)
                {
                    return null;
                }

                using var stream = response.Content.ReadAsStream();
                using var document = JsonDocument.Parse(stream);
                var root = document.RootElement;
                if (!root.TryGetProperty("kind", out var kind) || kind.GetString() != "status")
                {
                    return null;
                }

                if (!root.TryGetProperty("data", out var data)
                    || !data.TryGetProperty("pid", out var pidElement)
                    || !pidElement.TryGetUInt32(out var pid))
                {
                    return null;
                }

                var spineEvents = data.TryGetProperty("spine_events_count", out var eventsElement)
                    && eventsElement.TryGetInt32(out var parsed)
                        ? parsed
                        : 0;
                return new DaemonStatusReply(pid, spineEvents);
            }
            catch (Exception)
            {
                // 连接被拒/超时/非 JSON：握手失败，由调用方降级为 DetectedUnverified。
                return null;
            }
        }
    }
}
