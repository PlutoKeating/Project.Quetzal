import Foundation
import QuetzalcoatlCore

#if canImport(QuetzalcoatlBindings)
import QuetzalcoatlBindings

/// 把 UniFFI 的拉模式 `FfiViewStream` 包装成宿主 `StreamSource`。
/// 与 Rust 侧一致：批次有界（≤64）、取消幂等；宿主永远只主动拉取，绝无回调注册。
public final class UniffiStreamSource: StreamSource, @unchecked Sendable {
    private let stream: FfiViewStream
    private let lock = NSLock()

    public init(stream: FfiViewStream) {
        self.stream = stream
    }

    public func pull(maxEvents: Int) throws -> [StreamEvent]? {
        lock.lock()
        defer { lock.unlock() }

        if stream.isFinished() || stream.isCancelled() {
            return nil
        }

        let limit = UInt32(max(1, min(maxEvents, 64)))
        let batch: [FfiStreamEvent]
        do {
            batch = try stream.nextEvents(maxEvents: limit)
        } catch {
            // 正常结束（Finished/Cancelled）在类型层不可见；以状态位区分，其余错误上抛。
            if stream.isFinished() || stream.isCancelled() {
                return nil
            }
            throw error
        }

        if batch.isEmpty {
            return nil
        }

        var events: [StreamEvent] = []
        events.reserveCapacity(batch.count)
        for item in batch {
            events.append(StreamEvent(
                seq: item.seq,
                kind: try StreamEventKind(label: item.kind),
                text: item.text))
        }
        return events
    }

    /// 立即取消并释放原生流（幂等）。
    public func cancel() {
        lock.lock()
        defer { lock.unlock() }
        if !stream.isCancelled() {
            try? stream.cancel()
        }
    }
}

/// UniFFI 视图会话的薄包装：原生补丁与平台中立模型逐字段对应，
/// 保证「同一份绑定、同一套裁剪规则」在 macOS 侧不被重新发明。
public final class UniffiViewBridge: @unchecked Sendable {
    private let session: FfiViewSession

    public init(density: CognitionDensity) {
        self.session = FfiViewSession(density: Self.toFfi(density))
    }

    public func apply(_ patch: ViewPatch) throws {
        let ops: [FfiViewOp] = patch.ops.map { op in
            switch op {
            case .upsert(let row):
                .upsert(row: FfiViewRow(
                    key: row.key,
                    kind: row.kind,
                    summary: row.summary,
                    detail: row.detail,
                    rawJson: row.rawJSON,
                    updatedRev: row.updatedRev))
            case .remove(let key):
                .remove(key: key)
            }
        }
        try session.applyPatch(patch: FfiViewPatch(
            fromRev: patch.fromRev,
            toRev: patch.toRev,
            density: Self.toFfi(patch.density),
            ops: ops))
    }

    public func rev() throws -> UInt64 {
        try session.rev()
    }

    public func projectedRows() throws -> [ViewRow] {
        try session.projectedRows().map {
            ViewRow(
                key: $0.key,
                kind: $0.kind,
                summary: $0.summary,
                detail: $0.detail,
                rawJSON: $0.rawJson,
                updatedRev: $0.updatedRev)
        }
    }

    private static func toFfi(_ density: CognitionDensity) -> FfiCognitionDensity {
        switch density {
        case .companion: .companion
        case .workbench: .workbench
        case .inspector: .inspector
        }
    }
}

/// 流源工厂：绑定缺失时返回 `nil`，由界面进入类型化降级视图。
public enum StreamSourceFactory {
    /// 本构建是否链接了 UniFFI 原生绑定。
    public static var bindingsAvailable: Bool { true }

    /// 打开一个确定性的拉模式流（真实场景由回环网关 SSE 解析器驱动同一接口）。
    public static func open(eventCount: Int) -> (any StreamSource)? {
        UniffiStreamSource(stream: FfiViewStream(eventCount: UInt32(max(0, eventCount))))
    }
}

#else

/// 默认构建（无 `QuetzalcoatlBindings` 模块）：界面完整、降级视图类型化，绝不伪装在线。
public enum StreamSourceFactory {
    public static var bindingsAvailable: Bool { false }

    public static func open(eventCount: Int) -> (any StreamSource)? {
        _ = eventCount
        return nil
    }
}

#endif
