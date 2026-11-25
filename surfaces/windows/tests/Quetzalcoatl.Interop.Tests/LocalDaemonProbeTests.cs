namespace Quetzalcoatl.Interop.Tests;

using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Interop;

/// <summary>
/// 守护进程探测：只读运行时文件、类型化降级、绝不伪造在线。
/// 本测试不需要原生库（探测在绑定缺失时必须如实报告，而不是假装已连接）。
/// </summary>
public sealed class LocalDaemonProbeTests : IDisposable
{
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

    private void WriteRuntime(string json, bool withToken = true)
    {
        Directory.CreateDirectory(Path.Combine(_root, "run"));
        File.WriteAllText(Path.Combine(_root, "run", "daemon.json"), json);
        if (withToken)
        {
            File.WriteAllText(Path.Combine(_root, "run", "daemon.token"), new string('a', 64));
        }
    }

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
        WriteRuntime("""{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}""", withToken: false);

        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: true);

        Assert.False(result.Connection.IsOnline);
        Assert.False(result.TokenPresent);
    }

    [Fact]
    public void ValidRuntimeWithoutBindingsReportsTypedBindingsUnavailable()
    {
        WriteRuntime("""{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}""");

        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: false);

        Assert.False(result.Connection.IsOnline);
        Assert.True(result.TokenPresent);
        Assert.Contains("版本", result.Connection.Degraded!.Title, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidRuntimeWithBindingsReportsOnlinePidAndEndpoint()
    {
        WriteRuntime("""{"pid":4242,"ipc_http_addr":"127.0.0.1:4711"}""");

        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: true);

        var online = Assert.IsType<ConnectionState.Online>(result.Connection);
        Assert.Equal(4242u, online.Pid);
        Assert.Equal("127.0.0.1:4711", online.Endpoint);
        Assert.True(result.BindingsAvailable);
    }

    [Fact]
    public void MalformedRuntimeDegradesToTransportCopyWithTechnicalDetail()
    {
        WriteRuntime("{ broken");

        var result = LocalDaemonProbe.Probe(Home(), bindingsAvailable: true);

        Assert.False(result.Connection.IsOnline);
        Assert.NotNull(result.Connection.Degraded);
        Assert.Contains("解析", result.Technical, StringComparison.Ordinal);
    }
}
