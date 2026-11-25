import Foundation

/// 一条视图行。字段与 Rust `ViewRow` / UniFFI `FfiViewRow` 逐字段对齐。
public struct ViewRow: Sendable, Equatable, Identifiable {
    public var key: String
    public var kind: String
    public var summary: String
    public var detail: String?
    public var rawJSON: String?
    public var updatedRev: UInt64

    public var id: String { key }

    public init(
        key: String,
        kind: String,
        summary: String,
        detail: String? = nil,
        rawJSON: String? = nil,
        updatedRev: UInt64 = 0
    ) {
        self.key = key
        self.kind = kind
        self.summary = summary
        self.detail = detail
        self.rawJSON = rawJSON
        self.updatedRev = updatedRev
    }

    /// 按密度裁剪：陪伴态拿不到细节，工作台拿不到原始载荷。
    public func projected(_ density: CognitionDensity) -> ViewRow {
        var copy = self
        if !density.includes(.detail) { copy.detail = nil }
        if !density.includes(.raw) { copy.rawJSON = nil }
        return copy
    }
}

/// 视图补丁中的单个操作。
public enum ViewOp: Sendable, Equatable {
    case upsert(ViewRow)
    case remove(String)

    public var opKey: String {
        switch self {
        case .upsert(let row): row.key
        case .remove(let key): key
        }
    }
}

/// 补丁应用失败的类型化原因。
public enum PatchError: Error, Equatable, Sendable {
    case invalidRevision(from: UInt64, to: UInt64)
    case outOfSequence(expected: UInt64, actual: UInt64)
    case malformedOp(String)
}

/// 响应式差分包：宿主按 `fromRev → toRev` 幂等重放。
public struct ViewPatch: Sendable, Equatable {
    public var fromRev: UInt64
    public var toRev: UInt64
    public var density: CognitionDensity
    public var ops: [ViewOp]

    public init(fromRev: UInt64, toRev: UInt64, density: CognitionDensity, ops: [ViewOp] = []) {
        self.fromRev = fromRev
        self.toRev = toRev
        self.density = density
        self.ops = ops
    }
}

/// 客户端持有的完整视图快照；可由若干补丁从任意基线确定性重放得到。
public struct ViewState: Sendable, Equatable {
    public private(set) var rev: UInt64
    public private(set) var density: CognitionDensity
    private var storage: [String: ViewRow]

    public init(rev: UInt64, density: CognitionDensity) {
        self.rev = rev
        self.density = density
        self.storage = [:]
    }

    /// 按 key 升序的只读行集合（确定性顺序，不依赖哈希种子）。
    public var rows: [ViewRow] {
        storage.keys.sorted(by: Self.lexicographicallyPrecedes).compactMap { storage[$0] }
    }

    public var rowCount: Int { storage.count }

    public func row(_ key: String) -> ViewRow? { storage[key] }

    /// 幂等应用一个补丁：
    /// - `toRev == rev`：已应用过，直接成功（可安全重发）；
    /// - `fromRev != rev`：乱序，显式失败，绝不部分合并。
    public mutating func apply(_ patch: ViewPatch) throws {
        if patch.toRev < patch.fromRev {
            throw PatchError.invalidRevision(from: patch.fromRev, to: patch.toRev)
        }
        if patch.toRev == rev {
            return
        }
        guard rev == patch.fromRev else {
            throw PatchError.outOfSequence(expected: rev, actual: patch.fromRev)
        }

        for op in patch.ops {
            switch op {
            case .upsert(let row):
                guard !row.key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw PatchError.malformedOp("upsert 的视图行 key 不能为空")
                }
                storage[row.key] = row
            case .remove(let key):
                storage.removeValue(forKey: key)
            }
        }

        rev = patch.toRev
        density = patch.density
    }

    /// 计算到 `next` 的差分补丁；操作按 key 升序输出。
    public func diff(to next: ViewState) throws -> ViewPatch {
        guard next.rev >= rev else {
            throw PatchError.invalidRevision(from: rev, to: next.rev)
        }

        let toRev = next.rev > rev ? next.rev : rev &+ 1
        var ops: [ViewOp] = []
        for (key, row) in next.storage where storage[key] != row {
            ops.append(.upsert(row))
        }
        for key in storage.keys where next.storage[key] == nil {
            ops.append(.remove(key))
        }
        ops.sort { Self.lexicographicallyPrecedes($0.opKey, $1.opKey) }
        return ViewPatch(fromRev: rev, toRev: toRev, density: next.density, ops: ops)
    }

    /// 纯密度切换补丁（不产生任何行操作，但走同一套重放机制）。
    public func densityPatch(_ density: CognitionDensity) -> ViewPatch {
        ViewPatch(fromRev: rev, toRev: rev &+ 1, density: density, ops: [])
    }

    /// 按指定密度投影（确定性顺序）。
    public func projectedRows(_ density: CognitionDensity) -> [ViewRow] {
        rows.map { $0.projected(density) }
    }

    private static func lexicographicallyPrecedes(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
    }
}
