namespace Quetzalcoatl.Interop.Tests;

using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Interop;

/// <summary>
/// 守护进程探测：只读运行时文件 + **令牌认证的 status 握手**，绝不因为「文件存在」就宣称在线。
/// 本测试不需要原生库（可用桩传输覆盖成功路径）。
/// </summary>
public sealed class LocalDaemonProbeTests : IDisposable
{
    private sealed class StubTransport : IStatusTransport
    {
        private readonly DaemonStatusReply? _reply;

        public StubTransport(DaemonStatusReply? reply) => _reply = reply;

        public DaemonStatusReply? Fetch(string endpoint, string token)
        {
            _ = endpoint;
            _ = token;
            return _reply;
        }
    }

    private readonly string _root = Path.Combine(Path.GetTempPath(), $"qz-probe-{Guid.NewGuid():N}");

    public LocalDaemonProbeTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // 临时目录清理失败不影响断言结论。
        }
    }

    private HomePaths Home() => new(_root);

    private void WriteRuntime(string json, string? token = null)
    {
        Directory.CreateDirectory(Path.Combine(_root, "run"));
        File.WriteAllText(Path.Combine(_root, "run", "daemon.json"), json);
        if (token is not null)
        {
            File.WriteAllText(Path.Combine(_root, "run", "daemon.token"), token);
        }
    }

    private static uint LivePid() => (uint)Environment.ProcessId;

    private static string Token() => new('a', 64);

    [Fact]
    public void MissingRuntimeFilesDegradeToDaemonUnavailable()
    {
        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: false);

        Assert.False(result.Connection.IsOnline);
        Assert.NotNull(result.Connection.Degraded);
        Assert.Contains("还没启动", result.Connection.Degraded!.Title, StringComparison.Ordinal);
        Assert.False(result.TokenPresent);
    }

    [Fact]
    public void MissingTokenDegradesInsteadOfConnecting()
    {
        WriteRuntime("""{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}""");

        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: true);

        Assert.False(result.Connection.IsOnline);
        Assert.False(result.TokenPresent);
    }

    [Fact]
    public void ValidRuntimeWithoutBindingsReportsTypedBindingsUnavailable()
    {
        WriteRuntime("""{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}""", Token());

        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: false);

        Assert.False(result.Connection.IsOnline);
        Assert.True(result.TokenPresent);
        Assert.Contains("版本", result.Connection.Degraded!.Title, StringComparison.Ordinal);
    }

    [Fact]
    public void AuthenticatedHandshakeWithMatchingPidReportsOnline()
    {
        var pid = LivePid();
        WriteRuntime($$"""{"pid":{{pid}},"ipc_http_addr":"127.0.0.1:4711"}""", Token());

        var result = LocalDaemonProbe.Probe(
            Home(),
            bindingsAvailable: true,
            transport: new StubTransport(new DaemonStatusReply(pid, 42)));

        var online = Assert.IsType<ConnectionState.Online>(result.Connection);
        Assert.Equal(pid, online.Pid);
        Assert.Equal("127.0.0.1:4711", online.Endpoint);
        Assert.Equal(42, online.SpineEvents);
    }

    [Fact]
    public void StaleRuntimeWithDeadPidIsDetectedUnverified()
    {
        WriteRuntime("""{"pid":4000000,"ipc_http_addr":"127.0.0.1:4711"}""", Token());

        var result = LocalDaemonProbe.Probe(
            Home(),
            bindingsAvailable: true,
            transport: new StubTransport(new DaemonStatusReply(4_000_000, 0)));

        var unverified = Assert.IsType<ConnectionState.DetectedUnverified>(result.Connection);
        Assert.Equal(4_000_000u, unverified.Pid);
        Assert.False(result.Connection.IsOnline);
        Assert.Equal("找到了本机助手，但还没通过验证", result.Connection.Degraded?.Title);
        Assert.Contains("已退出", result.Technical, StringComparison.Ordinal);
    }

    [Fact]
    public void WrongTokenHandshakeFailureIsDetectedUnverified()
    {
        var pid = LivePid();
        WriteRuntime($$"""{"pid":{{pid}},"ipc_http_addr":"127.0.0.1:4711"}""", Token());

        var result = LocalDaemonProbe.Probe(
            Home(),
            bindingsAvailable: true,
            transport: new StubTransport(null));

        Assert.IsType<ConnectionState.DetectedUnverified>(result.Connection);
        Assert.False(result.Connection.IsOnline);
        Assert.Contains("握手失败", result.Technical, StringComparison.Ordinal);
    }

    [Fact]
    public void MismatchedPidIsDetectedUnverified()
    {
        var pid = LivePid();
        WriteRuntime($$"""{"pid":{{pid}},"ipc_http_addr":"127.0.0.1:4711"}""", Token());

        var result = LocalDaemonProbe.Probe(
            Home(),
            bindingsAvailable: true,
            transport: new StubTransport(new DaemonStatusReply(pid + 1, 0)));

        Assert.IsType<ConnectionState.DetectedUnverified>(result.Connection);
        Assert.Contains("不一致", result.Technical, StringComparison.Ordinal);
    }

    [Fact]
    public void MalformedTokenIsRejectedBeforeHandshake()
    {
        WriteRuntime("""{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}""", "not-a-token");

        var result = LocalDaemonProbe.Probe(
            Home(),
            bindingsAvailable: true,
            transport: new StubTransport(new DaemonStatusReply(42, 0)));

        Assert.IsType<ConnectionState.DetectedUnverified>(result.Connection);
        Assert.Contains("令牌格式非法", result.Technical, StringComparison.Ordinal);
    }

    [Fact]
    public void MalformedRuntimeDegradesToTransportCopyWithTechnicalDetail()
    {
        WriteRuntime("{ broken", Token());

        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: true);

        Assert.False(result.Connection.IsOnline);
        Assert.NotNull(result.Connection.Degraded);
        Assert.Contains("解析", result.Technical, StringComparison.Ordinal);
    }
}
