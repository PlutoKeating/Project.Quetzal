import Testing
@testable import QuetzalcoatlCore

@Suite("差分视图契约")
struct ViewStateTests {
    private func row(
        _ key: String,
        detail: String? = "detail",
        raw: String? = #"{"k":1}"#
    ) -> ViewRow {
        ViewRow(key: key, kind: "session", summary: "summary-\(key)", detail: detail, rawJSON: raw)
    }

    private func patch(_ from: UInt64, _ to: UInt64, _ ops: [ViewOp]) -> ViewPatch {
        ViewPatch(fromRev: from, toRev: to, density: .workbench, ops: ops)
    }

    @Test("同一补丁重放是幂等空操作")
    func replayingSamePatchIsIdempotent() throws {
        var state = ViewState(rev: 0, density: .workbench)
        let entry = patch(0, 1, [.upsert(row("a"))])
        try state.apply(entry)
        try state.apply(entry)

        #expect(state.rev == 1)
        #expect(state.rowCount == 1)
        #expect(state.row("a")?.summary == "summary-a")
    }

    @Test("乱序补丁显式失败且绝不部分合并")
    func outOfSequencePatchFailsWithoutPartialMerge() throws {
        var state = ViewState(rev: 0, density: .workbench)
        try state.apply(patch(0, 2, [.upsert(row("a"))]))

        do {
            try state.apply(patch(1, 3, [.upsert(row("b"))]))
            Issue.record("期望 outOfSequence，但补丁被接受")
        } catch let error as PatchError {
            guard case .outOfSequence(let expected, let actual) = error else {
                Issue.record("期望 outOfSequence，实际 \(error)")
                return
            }
            #expect(expected == 2)
            #expect(actual == 1)
        }

        #expect(state.rev == 2)
        #expect(state.rowCount == 1)
        #expect(state.row("b") == nil)
    }

    @Test("非法修订区间被拒绝")
    func invalidRevisionRangeIsRejected() {
        var state = ViewState(rev: 0, density: .workbench)
        do {
            try state.apply(patch(5, 3, []))
            Issue.record("期望 invalidRevision，但补丁被接受")
        } catch let error as PatchError {
            guard case .invalidRevision = error else {
                Issue.record("期望 invalidRevision，实际 \(error)")
                return
            }
        } catch {
            Issue.record("期望 PatchError，实际 \(error)")
        }
    }

    @Test("空 key 是 malformedOp 且状态不变")
    func emptyKeyIsMalformedAndLeavesStateUntouched() {
        var state = ViewState(rev: 0, density: .workbench)
        do {
            try state.apply(patch(0, 1, [.upsert(row("   "))]))
            Issue.record("期望 malformedOp，但补丁被接受")
        } catch let error as PatchError {
            guard case .malformedOp = error else {
                Issue.record("期望 malformedOp，实际 \(error)")
                return
            }
        } catch {
            Issue.record("期望 PatchError，实际 \(error)")
        }
        #expect(state.rowCount == 0)
    }

    @Test("三档投影严格嵌套")
    func densityProjectionIsStrictlyNested() throws {
        var state = ViewState(rev: 0, density: .workbench)
        try state.apply(patch(0, 1, [.upsert(row("a"))]))

        let companion = try #require(state.projectedRows(.companion).first)
        #expect(companion.summary == "summary-a")
        #expect(companion.detail == nil)
        #expect(companion.rawJSON == nil)

        let workbench = try #require(state.projectedRows(.workbench).first)
        #expect(workbench.detail == "detail")
        #expect(workbench.rawJSON == nil)

        let inspector = try #require(state.projectedRows(.inspector).first)
        #expect(inspector.detail == "detail")
        #expect(inspector.rawJSON == #"{"k":1}"#)
    }

    @Test("差分确定且密度补丁只推进修订")
    func diffIsDeterministicAndDensityPatchOnlyAdvancesRevision() throws {
        var left = ViewState(rev: 0, density: .workbench)
        try left.apply(patch(0, 1, [.upsert(row("b")), .upsert(row("a"))]))

        var right = ViewState(rev: 0, density: .workbench)
        try right.apply(patch(0, 1, [.upsert(row("b")), .upsert(row("a"))]))
        try right.apply(patch(1, 2, [.upsert(row("c"))]))

        let diff = try left.diff(to: right)
        #expect(diff.fromRev == 1)
        #expect(diff.toRev == 2)
        #expect(diff.ops.map(\.opKey) == ["c"])

        let density = left.densityPatch(.inspector)
        #expect(density.ops.isEmpty)
        #expect(density.toRev == 2)
        #expect(density.density == .inspector)
    }

    @Test("行顺序按 UTF-16 码元确定")
    func rowsAreSortedByUTF16CodeUnits() throws {
        var state = ViewState(rev: 0, density: .workbench)
        try state.apply(patch(0, 1, [.upsert(row("b")), .upsert(row("A")), .upsert(row("a"))]))
        #expect(state.rows.map(\.key) == ["A", "a", "b"])
    }
}
