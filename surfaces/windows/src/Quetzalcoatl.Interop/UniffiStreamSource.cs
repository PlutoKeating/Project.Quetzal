namespace Quetzalcoatl.Interop;

using Quetzalcoatl.Desktop.Model;
using Quetzalcoatl.Desktop.Streaming;

#if QZ_UNIFFI_BINDINGS
using Quetzalcoatl.Bindings;
#endif

/// <summary>
/// 把 UniFFI 的拉模式 <c>FfiViewStream</c> 包装成宿主 <see cref="IStreamSource"/>。
/// 与 Rust 侧一致：批次有界（≤64），取消幂等；宿主永远只主动拉取，绝无回调注册。
/// </summary>
#if QZ_UNIFFI_BINDINGS
public sealed class UniffiStreamSource : IStreamSource
{
    private readonly FfiViewStream _stream;
    private bool _disposed;

    /// <summary>包装一个已创建的原生流。</summary>
    public UniffiStreamSource(FfiViewStream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        _stream = stream;
    }

    /// <inheritdoc />
    public bool TryPull(int maxEvents, out IReadOnlyList<StreamEvent> events)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(maxEvents);
        var batch = _stream.NextEvents((uint)Math.Min(maxEvents, 64));
        var mapped = new List<StreamEvent>(batch.Length);
        foreach (var item in batch)
        {
            mapped.Add(new StreamEvent(item.Seq, StreamEvent.ParseKind(item.Kind), item.Text));
        }

        events = mapped;
        return batch.Length > 0 && !_stream.IsFinished();
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            _stream.Cancel();
        }
        catch (FfiException)
        {
            // 已结束/已取消：幂等释放路径保持静默。
        }

        _stream.Dispose();
        _disposed = true;
    }
}
#endif

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
        return new UniffiStreamSource(new FfiViewStream((uint)eventCount));
#else
        _ = eventCount;
        return null;
#endif
    }
}

#if QZ_UNIFFI_BINDINGS
/// <summary>
/// UniFFI 视图会话的薄包装：把原生 <c>FfiViewPatch</c> 映射为平台中立模型，
/// 保证「同一份绑定、同一套裁剪规则」在 Windows 侧不被重新发明。
/// </summary>
public sealed class UniffiViewBridge : IDisposable
{
    private readonly FfiViewSession _session;

    /// <summary>以指定密度创建原生视图会话。</summary>
    public UniffiViewBridge(FfiCognitionDensity density)
    {
        _session = new FfiViewSession(density);
    }

    /// <summary>在原生会话上幂等重放模型补丁。</summary>
    public void Apply(ViewPatch patch)
    {
        ArgumentNullException.ThrowIfNull(patch);
        var ops = new List<FfiViewOp>(patch.Ops.Count);
        foreach (var op in patch.Ops)
        {
            switch (op)
            {
                case ViewOp.Upsert upsert:
                    ops.Add(new FfiViewOp.Upsert(new FfiViewRow(
                        Key: upsert.Row.Key,
                        Kind: upsert.Row.Kind,
                        Summary: upsert.Row.Summary,
                        Detail: upsert.Row.Detail,
                        RawJson: upsert.Row.RawJson,
                        UpdatedRev: upsert.Row.UpdatedRev)));
                    break;
                case ViewOp.Remove remove:
                    ops.Add(new FfiViewOp.Remove(remove.Key));
                    break;
            }
        }

        _session.ApplyPatch(new FfiViewPatch(
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

    private static FfiCognitionDensity ToFfi(CognitionDensity density) => density switch
    {
        CognitionDensity.Companion => FfiCognitionDensity.Companion,
        CognitionDensity.Inspector => FfiCognitionDensity.Inspector,
        _ => FfiCognitionDensity.Workbench,
    };
}
#endif
