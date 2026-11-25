import Foundation
import Testing
@testable import QuetzalcoatlCore

@MainActor
private final class PumpMetrics {
    var maxCallbackMS = 0.0
    var batches = 0
    var completed = false
    var failed = false
}

private struct FailingSource: StreamSource {
    func pull(maxEvents: Int) throws -> [StreamEvent]? {
        _ = maxEvents
        throw StreamPumpError(message: "native stream broken")
    }
}

@MainActor
@Suite("拉模式流泵")
struct StreamPumpTests {
    @Test("5,000 事件高频流不阻塞主 actor")
    func fiveThousandEventsNeverBlockTheMainActor() async throws {
        let sink = RecordingAnnouncementSink()
        let viewModel = DesktopViewModel(model: .offline("test"), sink: sink)
        let metrics = PumpMetrics()
        let source = SyntheticStreamSource(eventCount: 5_000, chunkSize: 16)

        let pump = StreamPump(
            source: source,
            maxEventsPerPull: 16,
            onBatch: { events in
                let started = DispatchTime.now()
                viewModel.ingest(events)
                let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
                metrics.maxCallbackMS = max(metrics.maxCallbackMS, elapsed)
                metrics.batches += 1
            },
            onCompleted: { metrics.completed = true },
            onFailure: { _ in metrics.failed = true })

        pump.start()

        // 主 actor 看门狗：每 1ms 记录一次唤醒间隔；任何阻塞都会表现为长间隔。
        var maxGapMS = 0.0
        var lastTick = DispatchTime.now().uptimeNanoseconds
        let deadline = Date().addingTimeInterval(30)
        while !metrics.completed && !metrics.failed && Date() < deadline {
            try await Task.sleep(for: .milliseconds(1))
            let now = DispatchTime.now().uptimeNanoseconds
            maxGapMS = max(maxGapMS, Double(now - lastTick) / 1_000_000)
            lastTick = now
        }
        pump.stop()

        #expect(metrics.completed, "5,000 事件流未在 30s 内完成")
        #expect(!metrics.failed)
        #expect(viewModel.model.session.lastSeq == 5_000)
        #expect(viewModel.snapshot.transcript.contains("delta-4999"))
        #expect(viewModel.snapshot.transcript.components(separatedBy: "delta-0").count - 1 == 1)

        #expect(maxGapMS < 150, "主 actor 出现 \(maxGapMS)ms 停顿（阈值 150ms）")
        #expect(metrics.maxCallbackMS < 150, "单批落模型耗时 \(metrics.maxCallbackMS)ms（阈值 150ms）")
        #expect(metrics.batches > 0)
        #expect(!sink.texts.isEmpty, "流式批次必须产生播报")
        #expect(sink.texts.count <= metrics.batches)

        let stats = pump.stats
        print(
            "PUMP_STATS events=\(stats.pulledEvents) batches=\(stats.appliedBatches) "
                + "max_gap_ms=\(maxGapMS) max_callback_ms=\(metrics.maxCallbackMS) "
                + "announcements=\(sink.texts.count)")
    }

    @Test("源故障以类型化错误落到主 actor")
    func failingSourceSurfacesTypedErrorOnMainActor() async throws {
        let sink = RecordingAnnouncementSink()
        let viewModel = DesktopViewModel(model: .offline("test"), sink: sink)
        let metrics = PumpMetrics()

        let pump = StreamPump(
            source: FailingSource(),
            onBatch: { events in viewModel.ingest(events) },
            onCompleted: { metrics.completed = true },
            onFailure: { error in
                metrics.failed = true
                viewModel.onFaulted(error)
            })
        pump.start()

        let deadline = Date().addingTimeInterval(5)
        while !metrics.failed && Date() < deadline {
            try await Task.sleep(for: .milliseconds(1))
        }
        pump.stop()

        #expect(metrics.failed)
        #expect(viewModel.model.technicalLog.contains { $0.contains("native stream broken") })
        #expect(viewModel.model.notices.contains("这次没有收到回复，请稍后重试。"))
        #expect(pump.stats.appliedBatches == 0)
    }

    @Test("停止幂等且不再继续拉取")
    func stopIsIdempotentAndStopsPulling() async throws {
        let sink = RecordingAnnouncementSink()
        let viewModel = DesktopViewModel(model: .offline("test"), sink: sink)
        let source = SyntheticStreamSource(eventCount: 100_000, chunkSize: 8, delayPerPull: 0.002)
        let pump = viewModel.makePump(source: source, maxEventsPerPull: 8)
        pump.start()
        pump.stop()
        pump.stop()

        let seen = pump.stats.pulledEvents
        try await Task.sleep(for: .milliseconds(60))
        #expect(pump.stats.pulledEvents == seen)
        #expect(seen < 100_000)
    }
}
