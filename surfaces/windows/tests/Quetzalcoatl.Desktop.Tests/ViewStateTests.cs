namespace Quetzalcoatl.Desktop.Tests;

using Quetzalcoatl.Desktop.Model;

/// <summary>差分视图契约：幂等重放、乱序拒绝、三档裁剪严格嵌套。</summary>
public sealed class ViewStateTests
{
    private static ViewRow Row(string key, string? detail = "detail", string? raw = "{\"k\":1}") =>
        new(key, "session", $"summary-{key}", detail, raw, 0);

    private static ViewPatch Patch(ulong from, ulong to, params ViewOp[] ops) =>
        new(from, to, CognitionDensity.Workbench, ops);

    [Fact]
    public void ReplayingSamePatchIsIdempotent()
    {
        var state = new ViewState(0, CognitionDensity.Workbench);
        var patch = Patch(0, 1, new ViewOp.Upsert(Row("a")));

        state.Apply(patch);
        state.Apply(patch);

        Assert.Equal(1UL, state.Rev);
        Assert.Single(state.Rows);
        Assert.Equal("summary-a", state.Rows["a"].Summary);
    }

    [Fact]
    public void OutOfSequencePatchFailsWithoutPartialMerge()
    {
        var state = new ViewState(0, CognitionDensity.Workbench);
        state.Apply(Patch(0, 2, new ViewOp.Upsert(Row("a"))));

        var error = Assert.Throws<PatchException>(
            () => state.Apply(Patch(1, 3, new ViewOp.Upsert(Row("b")))));

        Assert.Equal(PatchErrorKind.OutOfSequence, error.Kind);
        Assert.Equal(2UL, error.Expected);
        Assert.Equal(1UL, error.Actual);
        Assert.Equal(2UL, state.Rev);
        Assert.Single(state.Rows);
        Assert.False(state.Rows.ContainsKey("b"));
    }

    [Fact]
    public void InvalidRevisionRangeIsRejected()
    {
        var state = new ViewState(0, CognitionDensity.Workbench);
        var error = Assert.Throws<PatchException>(() => state.Apply(Patch(5, 3)));
        Assert.Equal(PatchErrorKind.InvalidRevision, error.Kind);
    }

    [Fact]
    public void EmptyKeyIsMalformed()
    {
        var state = new ViewState(0, CognitionDensity.Workbench);
        var error = Assert.Throws<PatchException>(
            () => state.Apply(Patch(0, 1, new ViewOp.Upsert(Row("   ")))));
        Assert.Equal(PatchErrorKind.MalformedOp, error.Kind);
        Assert.Empty(state.Rows);
    }

    [Fact]
    public void CompanionKeepsOnlySummaryWhileInspectorKeepsEverything()
    {
        var state = new ViewState(0, CognitionDensity.Workbench);
        state.Apply(Patch(0, 1, new ViewOp.Upsert(Row("a"))));

        var companion = Assert.Single(state.ProjectedRows(CognitionDensity.Companion));
        Assert.Equal("summary-a", companion.Summary);
        Assert.Null(companion.Detail);
        Assert.Null(companion.RawJson);

        var workbench = Assert.Single(state.ProjectedRows(CognitionDensity.Workbench));
        Assert.Equal("detail", workbench.Detail);
        Assert.Null(workbench.RawJson);

        var inspector = Assert.Single(state.ProjectedRows(CognitionDensity.Inspector));
        Assert.Equal("detail", inspector.Detail);
        Assert.Equal("{\"k\":1}", inspector.RawJson);
    }

    [Fact]
    public void DiffIsDeterministicAndDensityPatchOnlyAdvancesRevision()
    {
        var left = new ViewState(0, CognitionDensity.Workbench);
        left.Apply(Patch(0, 1, new ViewOp.Upsert(Row("b")), new ViewOp.Upsert(Row("a"))));

        var right = new ViewState(0, CognitionDensity.Workbench);
        right.Apply(Patch(0, 1, new ViewOp.Upsert(Row("b")), new ViewOp.Upsert(Row("a"))));
        right.Apply(Patch(1, 2, new ViewOp.Upsert(Row("c"))));

        var patch = left.Diff(right);
        Assert.Equal(1UL, patch.FromRev);
        Assert.Equal(2UL, patch.ToRev);
        Assert.Equal(new[] { "c" }, patch.Ops.Select(op => op.OpKey).ToArray());

        var density = left.DensityPatch(CognitionDensity.Inspector);
        Assert.Empty(density.Ops);
        Assert.Equal(2UL, density.ToRev);
        Assert.Equal(CognitionDensity.Inspector, density.Density);
    }
}
