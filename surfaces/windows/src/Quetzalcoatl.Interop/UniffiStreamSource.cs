namespace Quetzalcoatl.Interop;

using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Streaming;

/// <summary>
/// 原生事件流的最小抽象：把「拉取/结束/取消」从 UniFFI 生成类型里剥离出来，
/// 使结束语义可以在没有原生库的机器上被真实单测覆盖。
/// </summary>
public interface INativeEventStream : IDisposable
{
    /// <summary>拉取至多 <paramref name="maxEvents"/> 个事件；正常结束时抛任意异常（由上层结合状态位判定）。</summary>
    IReadOnlyList<StreamEvent> NextEvents(int maxEvents);

    /// <summary>流是否已正常结束。</summary>
    bool IsFinished { get; }

    /// <summary>流是否已被取消。</summary>
    bool IsCancelled { get; }

    /// <summary>取消（幂等）。</summary>
    void Cancel();
}

/// <summary>
/// 把原生拉模式流包装成宿主 <see cref="IStreamSource"/>。
/// 与 Rust 侧一致：批次有界（≤64）、取消幂等；宿主永远只主动拉取，绝无回调注册。
/// <para>
/// 结束语义（与 macOS `UniffiBridge.swift` 逐条一致）：Rust 在流耗尽后返回
/// <c>Err(StreamFinished)</c>，因此拉取抛错时若 <see cref="INativeEventStream.IsFinished"/>
/// 或 <see cref="INativeEventStream.IsCancelled"/> 为真，必须映射为 <c>false</c>（正常结束），
/// 绝不能升级成「流故障」；只有真正的错误才向上抛。
/// </para>
/// </summary>
public sealed class UniffiStreamSource : IStreamSource
{
    private readonly INativeEventStream _stream;
    private bool _disposed;

    /// <summary>包装一个原生事件流。</summary>
    public UniffiStreamSource(INativeEventStream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        _stream = stream;
    }

    /// <inheritdoc />
    public bool TryPull(int maxEvents, out IReadOnlyList<StreamEvent> events)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxEvents);
        if (_stream.IsFinished || _stream.IsCancelled)
        {
            events = Array.Empty<StreamEvent>();
            return false;
        }

        IReadOnlyList<StreamEvent> batch;
        try
        {
            batch = _stream.NextEvents(Math.Min(maxEvents, 64));
        }
        catch (Exception) when (_stream.IsFinished || _stream.IsCancelled)
        {
            // 耗尽/取消不是故障：与 macOS 适配器保持一致，按正常结束处理。
            events = Array.Empty<StreamEvent>();
            return false;
        }

        if (batch.Count == 0)
        {
            events = Array.Empty<StreamEvent>();
            return false;
        }

        events = batch;
        return true;
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _stream.Cancel();
        _stream.Dispose();
    }
}

/// <summary>流源工厂：绑定缺失时返回 <c>null</c>，由界面进入类型化降级视图。</summary>
public static class StreamSourceFactory
{
    /// <summary>本构建是否链接了 UniFFI 原生绑定。</summary>
    public static bool BindingsAvailable =>
#if QZ_UNIFFI_BINDINGS
        true;
#else
        false;
#endif

    /// <summary>打开一个确定性的拉模式流（真实场景由回环网关 SSE 解析器驱动同一接口）。</summary>
    public static IStreamSource? Open(int eventCount)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(eventCount);
#if QZ_UNIFFI_BINDINGS
        return new UniffiStreamSource(new FfiNativeEventStream(new Quetzalcoatl.Bindings.FfiViewStream((uint)eventCount)));
#else
        _ = eventCount;
        return null;
#endif
    }
}

#if QZ_UNIFFI_BINDINGS

/// <summary>UniFFI 生成类型的薄适配（只在链接原生库的构建里编译）。</summary>
public sealed class FfiNativeEventStream : INativeEventStream
{
    private readonly Quetzalcoatl.Bindings.FfiViewStream _stream;

    /// <summary>包装生成的 <c>FfiViewStream</c>。</summary>
    public FfiNativeEventStream(Quetzalcoatl.Bindings.FfiViewStream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        _stream = stream;
    }

    /// <inheritdoc />
    public IReadOnlyList<StreamEvent> NextEvents(int maxEvents)
    {
        var batch = _stream.NextEvents((uint)Math.Min(maxEvents, 64));
        var mapped = new List<StreamEvent>(batch.Length);
        foreach (var item in batch)
        {
            mapped.Add(new StreamEvent(item.Seq, StreamEvent.ParseKind(item.Kind), item.Text));
        }

        return mapped;
    }

    /// <inheritdoc />
    public bool IsFinished => _stream.IsFinished();

    /// <inheritdoc />
    public bool IsCancelled => _stream.IsCancelled();

    /// <inheritdoc />
    public void Cancel()
    {
        if (_stream.IsCancelled())
        {
            return;
        }

        try
        {
            _stream.Cancel();
        }
        catch (Quetzalcoatl.Bindings.FfiException)
        {
            // 已结束/已取消：幂等释放路径保持静默。
        }
    }

    /// <inheritdoc />
    public void Dispose() => _stream.Dispose();
}

/// <summary>
/// UniFFI 视图会话的薄包装：把原生 <c>FfiViewPatch</c> 映射为平台中立模型，
/// 保证「同一份绑定、同一套裁剪规则」在 Windows 侧不被重新发明。
/// </summary>
public sealed class UniffiViewBridge : IDisposable
{
    private readonly Quetzalcoatl.Bindings.FfiViewSession _session;

    /// <summary>以指定密度创建原生视图会话。</summary>
    public UniffiViewBridge(Quetzalcoatl.Bindings.FfiCognitionDensity density)
    {
        _session = new Quetzalcoatl.Bindings.FfiViewSession(density);
    }

    /// <summary>在原生会话上幂等重放模型补丁。</summary>
    public void Apply(ViewPatch patch)
    {
        ArgumentNullException.ThrowIfNull(patch);
        var ops = new List<Quetzalcoatl.Bindings.FfiViewOp>(patch.Ops.Count);
        foreach (var op in patch.Ops)
        {
            switch (op)
            {
                case ViewOp.Upsert upsert:
                    ops.Add(new Quetzalcoatl.Bindings.FfiViewOp.Upsert(new Quetzalcoatl.Bindings.FfiViewRow(
                        Key: upsert.Row.Key,
                        Kind: upsert.Row.Kind,
                        Summary: upsert.Row.Summary,
                        Detail: upsert.Row.Detail,
                        RawJson: upsert.Row.RawJson,
                        UpdatedRev: upsert.Row.UpdatedRev)));
                    break;
                case ViewOp.Remove remove:
                    ops.Add(new Quetzalcoatl.Bindings.FfiViewOp.Remove(remove.Key));
                    break;
            }
        }

        _session.ApplyPatch(new Quetzalcoatl.Bindings.FfiViewPatch(
            FromRev: patch.FromRev,
            ToRev: patch.ToRev,
            Density: ToFfi(patch.Density),
            Ops: ops.ToArray()));
    }

    /// <summary>当前原生会话修订。</summary>
    public ulong Rev() => _session.Rev();

    /// <summary>按当前密度读回原生投影（用于跨端裁剪一致性断言）。</summary>
    public IReadOnlyList<ViewRow> ProjectedRows()
    {
        var rows = _session.ProjectedRows();
        var mapped = new List<ViewRow>(rows.Length);
        foreach (var row in rows)
        {
            mapped.Add(new ViewRow(row.Key, row.Kind, row.Summary, row.Detail, row.RawJson, row.UpdatedRev));
        }

        return mapped;
    }

    /// <inheritdoc />
    public void Dispose() => _session.Dispose();

    private static Quetzalcoatl.Bindings.FfiCognitionDensity ToFfi(CognitionDensity density) => density switch
    {
        CognitionDensity.Companion => Quetzalcoatl.Bindings.FfiCognitionDensity.Companion,
        CognitionDensity.Inspector => Quetzalcoatl.Bindings.FfiCognitionDensity.Inspector,
        _ => Quetzalcoatl.Bindings.FfiCognitionDensity.Workbench,
    };
}

#endif
