namespace Quetzalcoatl.Desktop.Model;

/// <summary>
/// 一条视图行。字段与 Rust <c>ViewRow</c> / UniFFI <c>FfiViewRow</c> 逐字段对齐，
/// 保证三端（Rust/Swift/C#）的裁剪规则完全一致。
/// </summary>
public sealed record ViewRow(
    string Key,
    string Kind,
    string Summary,
    string? Detail,
    string? RawJson,
    ulong UpdatedRev)
{
    /// <summary>按密度裁剪：陪伴态拿不到细节，工作台拿不到原始载荷。</summary>
    public ViewRow Project(CognitionDensity density) => this with
    {
        Detail = density.Includes(DetailLayer.Detail) ? Detail : null,
        RawJson = density.Includes(DetailLayer.Raw) ? RawJson : null,
    };
}

/// <summary>视图补丁中的单个操作。</summary>
public abstract record ViewOp
{
    /// <summary>新增或整体替换一行。</summary>
    public sealed record Upsert(ViewRow Row) : ViewOp;

    /// <summary>删除一行（不存在的 key 是安全空操作）。</summary>
    public sealed record Remove(string Key) : ViewOp;

    /// <summary>操作作用的 key（差分排序使用）。</summary>
    public string OpKey => this switch
    {
        Upsert upsert => upsert.Row.Key,
        Remove remove => remove.Key,
        _ => string.Empty,
    };
}

/// <summary>补丁应用失败的类型化原因。</summary>
public enum PatchErrorKind
{
    /// <summary>补丁修订区间非法（<c>to_rev &lt; from_rev</c>）。</summary>
    InvalidRevision,

    /// <summary>补丁与本地修订不连续；绝不部分合并。</summary>
    OutOfSequence,

    /// <summary>操作非法（例如空 key）。</summary>
    MalformedOp,
}

/// <summary>补丁应用失败。</summary>
public sealed class PatchException : Exception
{
    /// <summary>构造类型化补丁错误。</summary>
    public PatchException(PatchErrorKind kind, string message, ulong expected = 0, ulong actual = 0)
        : base(message)
    {
        Kind = kind;
        Expected = expected;
        Actual = actual;
    }

    /// <summary>错误类别。</summary>
    public PatchErrorKind Kind { get; }

    /// <summary>本地修订（乱序时有效）。</summary>
    public ulong Expected { get; }

    /// <summary>补丁起始修订（乱序时有效）。</summary>
    public ulong Actual { get; }
}

/// <summary>响应式差分包：宿主按 <c>FromRev → ToRev</c> 幂等重放。</summary>
public sealed record ViewPatch(ulong FromRev, ulong ToRev, CognitionDensity Density, IReadOnlyList<ViewOp> Ops);

/// <summary>
/// 客户端持有的完整视图快照。可由若干 <see cref="ViewPatch"/> 从任意基线确定性重放得到。
/// </summary>
public sealed class ViewState
{
    private readonly SortedDictionary<string, ViewRow> _rows = new(StringComparer.Ordinal);

    /// <summary>以指定修订与密度构造空快照。</summary>
    public ViewState(ulong rev, CognitionDensity density)
    {
        Rev = rev;
        Density = density;
    }

    /// <summary>当前修订号。</summary>
    public ulong Rev { get; private set; }

    /// <summary>当前密度。</summary>
    public CognitionDensity Density { get; private set; }

    /// <summary>按 key 升序的只读行集合（确定性顺序，不依赖哈希种子）。</summary>
    public IReadOnlyDictionary<string, ViewRow> Rows => _rows;

    /// <summary>
    /// 幂等应用一个补丁：
    /// <list type="bullet">
    /// <item><c>ToRev == Rev</c>：已应用过，直接成功（可安全重发）；</item>
    /// <item><c>FromRev != Rev</c>：乱序，显式失败，绝不部分合并。</item>
    /// </list>
    /// </summary>
    public void Apply(ViewPatch patch)
    {
        ArgumentNullException.ThrowIfNull(patch);
        if (patch.ToRev < patch.FromRev)
        {
            throw new PatchException(
                PatchErrorKind.InvalidRevision,
                $"视图补丁修订区间非法: from_rev={patch.FromRev}, to_rev={patch.ToRev}",
                patch.FromRev,
                patch.ToRev);
        }

        if (patch.ToRev == Rev)
        {
            return;
        }

        if (Rev != patch.FromRev)
        {
            throw new PatchException(
                PatchErrorKind.OutOfSequence,
                $"视图补丁序裂: 本地 rev={Rev}, 补丁 from_rev={patch.FromRev}",
                Rev,
                patch.FromRev);
        }

        foreach (var op in patch.Ops)
        {
            switch (op)
            {
                case ViewOp.Upsert upsert:
                    if (string.IsNullOrWhiteSpace(upsert.Row.Key))
                    {
                        throw new PatchException(PatchErrorKind.MalformedOp, "upsert 的视图行 key 不能为空");
                    }

                    _rows[upsert.Row.Key] = upsert.Row;
                    break;
                case ViewOp.Remove remove:
                    _rows.Remove(remove.Key);
                    break;
                default:
                    throw new PatchException(PatchErrorKind.MalformedOp, "未知的视图操作");
            }
        }

        Rev = patch.ToRev;
        Density = patch.Density;
    }

    /// <summary>计算到 <paramref name="next"/> 的差分补丁；操作按 key 升序输出。</summary>
    public ViewPatch Diff(ViewState next)
    {
        ArgumentNullException.ThrowIfNull(next);
        if (next.Rev < Rev)
        {
            throw new PatchException(
                PatchErrorKind.InvalidRevision,
                $"视图补丁修订区间非法: from_rev={Rev}, to_rev={next.Rev}",
                Rev,
                next.Rev);
        }

        var toRev = next.Rev > Rev ? next.Rev : Rev == ulong.MaxValue ? Rev : Rev + 1;
        var ops = new List<ViewOp>();
        foreach (var (key, row) in next.Rows)
        {
            if (!_rows.TryGetValue(key, out var current) || current != row)
            {
                ops.Add(new ViewOp.Upsert(row));
            }
        }

        foreach (var key in _rows.Keys)
        {
            if (!next.Rows.ContainsKey(key))
            {
                ops.Add(new ViewOp.Remove(key));
            }
        }

        ops.Sort(static (left, right) => string.CompareOrdinal(left.OpKey, right.OpKey));
        return new ViewPatch(Rev, toRev, next.Density, ops);
    }

    /// <summary>纯密度切换补丁（不产生任何行操作，但走同一套重放机制）。</summary>
    public ViewPatch DensityPatch(CognitionDensity density) =>
        new(Rev, Rev == ulong.MaxValue ? Rev : Rev + 1, density, Array.Empty<ViewOp>());

    /// <summary>按当前密度投影（确定性顺序）。</summary>
    public IReadOnlyList<ViewRow> Project() => ProjectedRows(Density);

    /// <summary>按指定密度投影。</summary>
    public IReadOnlyList<ViewRow> ProjectedRows(CognitionDensity density) =>
        _rows.Values.Select(row => row.Project(density)).ToArray();
}
