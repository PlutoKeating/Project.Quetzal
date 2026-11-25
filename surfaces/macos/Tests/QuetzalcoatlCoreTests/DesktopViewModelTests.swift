import Foundation
import Combine
import Testing
@testable import QuetzalcoatlCore

@MainActor
final class RecordingAnnouncementSink: AnnouncementSink {
    private(set) var texts: [String] = []

    func announce(_ text: String) {
        texts.append(text)
    }
}

@MainActor
@Suite("视图模型绑定")
struct DesktopViewModelTests {
    private func offlineViewModel() -> (DesktopViewModel, RecordingAnnouncementSink) {
        let sink = RecordingAnnouncementSink()
        let viewModel = DesktopViewModel(model: .offline("test: daemon.json 缺失"), sink: sink)
        return (viewModel, sink)
    }

    @Test("离线模型绑定类型化零术语文案")
    func degradedModelBindsTypedOfflineCopyWithoutJargon() {
        let (viewModel, _) = offlineViewModel()
        let snapshot = viewModel.snapshot

        #expect(snapshot.isDegraded)
        #expect(!snapshot.isOnline)
        #expect(!snapshot.isInputEnabled)
        #expect(snapshot.showRetry)
        #expect(snapshot.showHint)
        #expect(snapshot.heading == CompanionCopy.headingOffline)
        #expect(snapshot.transcript == CompanionCopy.emptyOffline)
        #expect(snapshot.statusText == CompanionCopy.statusOffline)
        #expect(snapshot.degradedDetail.contains("暂时联系不上本机的助手"))

        let jargon = ZeroJargon.audit([
            snapshot.heading,
            snapshot.transcript,
            snapshot.statusText,
            snapshot.degradedTitle,
            snapshot.degradedDetail,
        ])
        #expect(jargon.isEmpty, "陪伴态出现技术词: \(jargon)")
    }

    @Test("离线输入只留在本机并明确提示")
    func offlineComposerKeepsTextLocalAndSaysSo() {
        let (viewModel, _) = offlineViewModel()
        viewModel.pushUserMessage("今晚给花浇水")

        #expect(viewModel.model.session.messages.count == 1)
        #expect(viewModel.model.notices.contains(CompanionCopy.offlineSendNotice))
        #expect(viewModel.snapshot.notices.contains(CompanionCopy.offlineSendNotice))
    }

    @Test("视图模型绑定在消费批次时发布变更")
    func viewModelBindingPublishesOnIngest() {
        let (viewModel, _) = offlineViewModel()
        final class Counter {
            var value = 0
        }
        let counter = Counter()
        let cancellable = viewModel.objectWillChange.sink { _ in counter.value += 1 }
        defer { cancellable.cancel() }

        viewModel.ingest([StreamEvent(seq: 1, kind: .delta, text: "你好")])

        #expect(counter.value > 0)
        #expect(viewModel.snapshot.transcript.contains("你好"))
    }

    @Test("切换密度保留行与会话且不产生播报")
    func densitySwitchPreservesRowsAndSessionAndDoesNotAnnounce() throws {
        var model = UiModel.online(pid: 42, endpoint: "127.0.0.1:4711", spineEvents: 3, density: .workbench)
        try model.applyPatch(ViewPatch(
            fromRev: 0,
            toRev: 1,
            density: .workbench,
            ops: [
                .upsert(ViewRow(
                    key: "session/a",
                    kind: UiModel.kindSession,
                    summary: "会话 A",
                    detail: "细节 A",
                    rawJSON: #"{"a":1}"#,
                    updatedRev: 1)),
                .upsert(ViewRow(
                    key: "approval/x",
                    kind: UiModel.kindApproval,
                    summary: "待批准",
                    updatedRev: 1)),
            ]))
        let sink = RecordingAnnouncementSink()
        let viewModel = DesktopViewModel(model: model, sink: sink)
        viewModel.ingest([StreamEvent(seq: 1, kind: .delta, text: "你好")])

        let announcementsBefore = viewModel.announcementCount
        viewModel.applyDensity(.inspector)

        #expect(viewModel.density == .inspector)
        #expect(viewModel.snapshot.windowTitle == "Quetzalcoatl · 检视")
        #expect(viewModel.model.session.messages.count == 1)
        #expect(viewModel.snapshot.sessions.count == 1)
        #expect(viewModel.snapshot.approvals.count == 1)
        #expect(viewModel.announcementCount == announcementsBefore)

        viewModel.applyDensity(.companion)
        let companionRow = try #require(viewModel.model.view.projectedRows(.companion).first { $0.key == "session/a" })
        #expect(companionRow.detail == nil)
        let inspectorRow = try #require(viewModel.model.view.projectedRows(.inspector).first { $0.key == "session/a" })
        #expect(inspectorRow.detail == "细节 A")
        #expect(viewModel.announcementCount == announcementsBefore)
    }

    @Test("混合批次只播报一次且错误优先")
    func mixedBatchAnnouncesErrorExactlyOnceAndPrefersIt() {
        let (viewModel, sink) = offlineViewModel()

        viewModel.ingest([
            StreamEvent(seq: 1, kind: .delta, text: "土壤湿度偏低，"),
            StreamEvent(seq: 2, kind: .error, text: "上游连接中断"),
            StreamEvent(seq: 3, kind: .delta, text: "我建议今晚浇水。"),
        ])

        #expect(sink.texts.count == 1)
        #expect(sink.texts.first?.contains("上游连接中断") == true)
        #expect(viewModel.announcementCount == 1)
        #expect(viewModel.snapshot.transcript.contains("上游连接中断"))
    }

    @Test("序号 0 也必须参与幂等去重")
    func sequenceZeroIsNotExemptFromDeduplication() {
        let (viewModel, sink) = offlineViewModel()
        let batch = [
            StreamEvent(seq: 0, kind: .delta, text: "第一句"),
            StreamEvent(seq: 1, kind: .delta, text: "第二句"),
        ]

        viewModel.ingest(batch)
        viewModel.ingest(batch)

        #expect(sink.texts.count == 1)
        #expect(viewModel.announcementCount == 1)
        #expect(viewModel.snapshot.transcript.components(separatedBy: "第一句").count - 1 == 1)
    }

    @Test("重复批次不重复正文也不重复播报")
    func duplicateBatchDoesNotDuplicateTextOrAnnouncement() {
        let (viewModel, sink) = offlineViewModel()
        let batch = [
            StreamEvent(seq: 1, kind: .delta, text: "今晚"),
            StreamEvent(seq: 2, kind: .delta, text: "补一次透水。"),
        ]

        viewModel.ingest(batch)
        viewModel.ingest(batch)

        #expect(sink.texts.count == 1)
        #expect(viewModel.announcementCount == 1)
        #expect(viewModel.snapshot.transcript.components(separatedBy: "今晚").count - 1 == 1)
    }

    @Test("回复批次保持连接状态不变且只播报一次")
    func replyBatchesKeepConnectionStatusStableAndAnnounceOnce() {
        let sink = RecordingAnnouncementSink()
        let viewModel = DesktopViewModel(
            model: .online(pid: 7, endpoint: "127.0.0.1:9", spineEvents: 5, density: .workbench),
            sink: sink)
        let before = viewModel.snapshot.statusText

        viewModel.ingest([
            StreamEvent(seq: 1, kind: .delta, text: "第一段"),
            StreamEvent(seq: 2, kind: .delta, text: "第二段"),
        ])

        // status.connection 是实时区域：回复批次不得改动它，否则会二次播报。
        #expect(viewModel.snapshot.statusText == before)
        #expect(viewModel.snapshot.statusText == CompanionCopy.statusOnline)
        #expect(viewModel.snapshot.streamingIndicator == CompanionCopy.statusStreaming)
        #expect(viewModel.announcementCount == 1)

        viewModel.ingest([StreamEvent(seq: 3, kind: .done, text: "stop")])
        #expect(viewModel.snapshot.streamingIndicator.isEmpty)
        #expect(viewModel.snapshot.statusText == before)
    }

    @Test("Done 事件收束流")
    func doneEventStopsStreaming() {
        let (viewModel, _) = offlineViewModel()
        viewModel.ingest([
            StreamEvent(seq: 1, kind: .delta, text: "好的。"),
            StreamEvent(seq: 2, kind: .done, text: "stop"),
        ])

        #expect(!viewModel.snapshot.isStreaming)
        #expect(viewModel.snapshot.statusText == CompanionCopy.statusOffline)
    }

    @Test("流故障给出提示与技术细节")
    func faultedStreamSurfacesNoticeAndTechnicalDetail() {
        let (viewModel, _) = offlineViewModel()
        viewModel.onFaulted(StreamPumpError(message: "native stream broken"))

        #expect(viewModel.model.notices.contains("这次没有收到回复，请稍后重试。"))
        #expect(viewModel.model.technicalLog.contains { $0.contains("native stream broken") })
        #expect(ZeroJargon.audit(viewModel.model.notices).isEmpty)
    }

    @Test("在线模型允许输入并显示已连接")
    func onlineModelExposesConnectedCopyAndEnablesComposer() {
        let sink = RecordingAnnouncementSink()
        let viewModel = DesktopViewModel(
            model: .online(pid: 7, endpoint: "127.0.0.1:9", spineEvents: 5, density: .workbench),
            sink: sink)

        #expect(viewModel.snapshot.isOnline)
        #expect(viewModel.snapshot.isInputEnabled)
        #expect(!viewModel.snapshot.showRetry)
        #expect(viewModel.snapshot.heading == CompanionCopy.headingOnline)
        #expect(viewModel.snapshot.statusText == CompanionCopy.statusOnline)
    }
}
