import Foundation

/// 拉模式事件源：唯一的读取入口。实现可以是真实 UniFFI `FfiViewStream`（经 Interop）
/// 或确定性的合成源（演示与测试）。
public protocol StreamSource: Sendable {
    /// 阻塞拉取至多 `maxEvents` 个事件；返回 `nil` 表示流已正常结束。批次必须有界。
    func pull(maxEvents: Int) throws -> [StreamEvent]?
}

/// 生产者 → 消费者的信号（保证批次顺序与结束/失败语义）。
public enum StreamSignal: Sendable {
    case batch([StreamEvent])
    case failure(String)
    case finished
}

/// 流泵的异常类型。
public struct StreamPumpError: Error, Sendable, CustomStringConvertible {
    public let message: String
    public init(message: String) { self.message = message }
    public var description: String { message }
}

/// 流泵的可观测统计（快照）。
public struct PumpStats: Sendable, Equatable {
    public var pulledEvents = 0
    public var appliedBatches = 0
    public var maxDispatchLatencyMS = 0.0
    public var completed = false
    public var failed = false
    public init() {}
}

/// 后台流泵：专用线程阻塞拉取事件、合并高频更新，单一 MainActor 消费者按顺序落模型，
/// 因此主线程只做增量合并与绑定通知，永不阻塞在拉取上。
public final class StreamPump: @unchecked Sendable {
    public typealias BatchHandler = @MainActor @Sendable ([StreamEvent]) -> Void
    public typealias CompletionHandler = @MainActor @Sendable () -> Void
    public typealias FailureHandler = @MainActor @Sendable (Error) -> Void
    public typealias StatsHandler = @MainActor @Sendable (PumpStats) -> Void

    private final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var stats = PumpStats()
        private var stopped = false
        private var started = false
        private var yieldedAt = DispatchTime.now()

        func isStopped() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return stopped
        }

        func markStarted() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if started { return false }
            started = true
            return true
        }

        func stop() {
            lock.lock()
            stopped = true
            lock.unlock()
        }

        func addPulled(_ count: Int) {
            lock.lock()
            stats.pulledEvents += count
            lock.unlock()
        }

        func markYield() {
            lock.lock()
            yieldedAt = DispatchTime.now()
            lock.unlock()
        }

        func recordBatch(startedAt: DispatchTime) {
            let finished = DispatchTime.now()
            lock.lock()
            stats.appliedBatches += 1
            let latency = Double(finished.uptimeNanoseconds - startedAt.uptimeNanoseconds) / 1_000_000
            stats.maxDispatchLatencyMS = max(stats.maxDispatchLatencyMS, latency)
            lock.unlock()
        }

        func markCompleted() {
            lock.lock()
            stats.completed = true
            lock.unlock()
        }

        func markFailed() {
            lock.lock()
            stats.failed = true
            lock.unlock()
        }

        func snapshot() -> PumpStats {
            lock.lock()
            defer { lock.unlock() }
            return stats
        }
    }

    private let source: any StreamSource
    private let maxEventsPerPull: Int
    private let continuation: AsyncStream<StreamSignal>.Continuation
    private let consumer: Task<Void, Never>
    private let state: State

    public init(
        source: any StreamSource,
        maxEventsPerPull: Int = 32,
        onBatch: @escaping BatchHandler,
        onCompleted: @escaping CompletionHandler,
        onFailure: @escaping FailureHandler,
        onStats: StatsHandler? = nil
    ) {
        let state = State()
        self.state = state
        self.source = source
        self.maxEventsPerPull = min(max(maxEventsPerPull, 1), 64)

        let (stream, continuation) = AsyncStream.makeStream(of: StreamSignal.self)
        self.continuation = continuation

        self.consumer = Task { @MainActor in
            for await signal in stream {
                switch signal {
                case .batch(let events):
                    let started = DispatchTime.now()
                    onBatch(events)
                    state.recordBatch(startedAt: started)
                    onStats?(state.snapshot())
                case .failure(let message):
                    state.markFailed()
                    onFailure(StreamPumpError(message: message))
                case .finished:
                    state.markCompleted()
                    onCompleted()
                }
            }
        }
    }

    deinit {
        stop()
    }

    /// 当前统计快照。
    public var stats: PumpStats { state.snapshot() }

    /// 启动后台拉取线程（幂等）。
    public func start() {
        guard state.markStarted() else { return }
        let source = self.source
        let continuation = self.continuation
        let state = self.state
        let maxEvents = self.maxEventsPerPull
        let thread = Thread {
            Self.produce(
                source: source,
                continuation: continuation,
                state: state,
                maxEventsPerPull: maxEvents)
        }
        thread.name = "qz-mac-stream-pump"
        thread.start()
    }

    /// 请求停止（幂等）：生产者在下一次拉取返回后收束，消费者被取消。
    public func stop() {
        state.stop()
        continuation.finish()
        consumer.cancel()
    }

    private static func produce(
        source: any StreamSource,
        continuation: AsyncStream<StreamSignal>.Continuation,
        state: State,
        maxEventsPerPull: Int
    ) {
        var pending: [StreamEvent] = []
        var lastYield = DispatchTime.now()

        while !state.isStopped() {
            do {
                guard let events = try source.pull(maxEvents: maxEventsPerPull) else {
                    if !pending.isEmpty {
                        state.markYield()
                        continuation.yield(.batch(pending))
                    }
                    continuation.yield(.finished)
                    continuation.finish()
                    return
                }

                if events.isEmpty {
                    Thread.sleep(forTimeInterval: 0.005)
                    continue
                }

                state.addPulled(events.count)
                pending.append(contentsOf: events)

                let now = DispatchTime.now()
                let elapsedMS = Double(now.uptimeNanoseconds - lastYield.uptimeNanoseconds) / 1_000_000
                if pending.count >= 256 || elapsedMS >= 8 {
                    state.markYield()
                    continuation.yield(.batch(pending))
                    pending.removeAll(keepingCapacity: true)
                    lastYield = now
                }
            } catch {
                if !pending.isEmpty {
                    state.markYield()
                    continuation.yield(.batch(pending))
                }
                state.markFailed()
                continuation.yield(.failure(String(describing: error)))
                continuation.finish()
                return
            }
        }

        continuation.finish()
    }
}

/// 确定性合成源：产生 `eventCount` 个 `.delta` 事件后以 `.done` 收束。
public final class SyntheticStreamSource: StreamSource, @unchecked Sendable {
    private let lock = NSLock()
    private var nextSeq = 0
    private let eventCount: Int
    private let chunkSize: Int
    private let delayPerPull: TimeInterval

    public init(eventCount: Int, chunkSize: Int = 32, delayPerPull: TimeInterval = 0) {
        self.eventCount = max(0, eventCount)
        self.chunkSize = max(1, chunkSize)
        self.delayPerPull = max(0, delayPerPull)
    }

    public func pull(maxEvents: Int) throws -> [StreamEvent]? {
        if delayPerPull > 0 {
            Thread.sleep(forTimeInterval: delayPerPull)
        }

        lock.lock()
        defer { lock.unlock() }

        if nextSeq > eventCount {
            return nil
        }

        let limit = max(1, min(maxEvents, chunkSize))
        var produced: [StreamEvent] = []
        produced.reserveCapacity(limit)
        while produced.count < limit {
            if nextSeq < eventCount {
                let seq = UInt64(nextSeq)
                nextSeq += 1
                produced.append(StreamEvent(seq: seq, kind: .delta, text: "delta-\(seq)"))
                continue
            }

            if nextSeq == eventCount {
                nextSeq += 1
                produced.append(StreamEvent(seq: UInt64(eventCount), kind: .done, text: "done"))
            }
            break
        }

        return produced
    }
}
