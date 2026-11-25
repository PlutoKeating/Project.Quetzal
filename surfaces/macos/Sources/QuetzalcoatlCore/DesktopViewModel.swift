import Combine
import Foundation

/// 陪伴态的全部用户可见文案（单一来源，供零术语审计与视图绑定使用）。
public enum CompanionCopy {
    public static let headingOnline = "今天想聊点什么？"
    public static let headingOffline = "我还没连上本机的助手"
    public static let emptyOnline = "我在这儿。想说什么都可以。"
    public static let emptyOffline = "助手启动后，我们刚才聊到哪儿都会接上。"
    public static let statusOnline = "已连接"
    public static let statusStreaming = "正在回复…"
    public static let statusOffline = "已断开"
    public static let retryLabel = "重新连接"
    public static let sendLabel = "发送"
    public static let entryPlaceholder = "想说什么都行"
    public static let entryLabel = "想说的话"
    public static let entryHint = "输入一句话，按回车或点发送"
    public static let transcriptLabel = "对话内容"
    public static let transcriptHint = "对话会持续更新，新的回复会自动播报"
    public static let offlineSendNotice = "还没连上本机助手，这句话只留在本机窗口里，不会被发送。"
    public static let bindingsUnavailableNotice = "这个版本缺少连接本机助手的组件，界面部分仍可正常使用。"

    public static let all: [String] = [
        headingOnline, headingOffline, emptyOnline, emptyOffline,
        statusOnline, statusStreaming, statusOffline,
        retryLabel, sendLabel, entryPlaceholder, entryLabel, entryHint,
        transcriptLabel, transcriptHint, offlineSendNotice, bindingsUnavailableNotice,
    ]
}

/// 可观测的实时播报出口（界面接到 `NSAccessibility.post(.announcementRequested)`）。
@MainActor
public protocol AnnouncementSink: AnyObject {
    func announce(_ text: String)
}

/// 一次视图刷新的完整投影（单个 `@Published` 变更 = 一次渲染，避免高频流把 SwiftUI 拖垮）。
public struct DesktopSnapshot: Sendable, Equatable {
    public var density: CognitionDensity
    public var windowTitle: String
    public var heading: String
    public var transcript: String
    public var streamingText: String
    public var hintText: String
    public var showHint: Bool
    public var showRetry: Bool
    public var isInputEnabled: Bool
    public var statusText: String
    public var isDegraded: Bool
    public var degradedTitle: String
    public var degradedDetail: String
    public var isOnline: Bool
    public var isStreaming: Bool
    public var sessions: [ViewRow]
    public var workflows: [ViewRow]
    public var approvals: [ViewRow]
    public var tools: [ViewRow]
    public var auditRows: [ViewRow]
    public var statusRows: [ViewRow]
    public var conscienceBody: String
    public var notices: [String]
    public var technicalLog: [String]
}

/// 桌面端视图模型：唯一可绑定的状态出口。所有成员都在主 actor 上；
/// 后台线程只经 `StreamPump` 的单一 MainActor 消费者投递批次。
@MainActor
public final class DesktopViewModel: ObservableObject {
    @Published public private(set) var snapshot: DesktopSnapshot
    @Published public private(set) var lastAnnouncement: String = ""
    @Published public private(set) var announcementCount: Int = 0
    @Published public private(set) var pumpSummary: String = "流泵未启动。"

    public private(set) var model: UiModel
    private let sink: any AnnouncementSink

    public init(model: UiModel, sink: any AnnouncementSink) {
        self.model = model
        self.sink = sink
        self.snapshot = Self.makeSnapshot(model)
    }

    /// 当前密度。
    public var density: CognitionDensity { model.density }

    /// 切换密度：只推进纯密度补丁，保留全部会话/流状态。
    public func applyDensity(_ density: CognitionDensity) {
        guard model.setDensity(density) else { return }
        publish()
    }

    /// 更新连接状态（必须由真实探测结果驱动，绝不伪造在线）。
    public func setConnection(_ connection: ConnectionState) {
        model.connection = connection
        publish()
    }

    /// 追加用户消息（本地回显）；离线时只留本地提示。
    public func pushUserMessage(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.pushUserMessage(text)
        if !model.connection.isOnline {
            model.notice(CompanionCopy.offlineSendNotice)
        }
        publish()
    }

    /// 记录一条本地提示。
    public func notice(_ text: String) {
        model.notice(text)
        publish()
    }

    /// 记录一条技术细节（仅检视态）。
    public func technical(_ text: String) {
        model.technical(text)
        publish()
    }

    /// 收束当前流。
    public func finishStream() {
        model.finishStream()
        publish()
    }

    /// 把流泵统计写入检视态摘要。
    public func applyPumpStats(_ stats: PumpStats) {
        pumpSummary = String(
            format: "流泵：事件 %d，合并批次 %d，最大落模型耗时 %.1fms，完成 %@，故障 %@",
            stats.pulledEvents,
            stats.appliedBatches,
            stats.maxDispatchLatencyMS,
            stats.completed ? "是" : "否",
            stats.failed ? "是" : "否")
    }

    /// 消费一个批次：幂等合并 + **恰好一次**播报 + 单次快照刷新。
    public func ingest(_ events: [StreamEvent]) {
        let ingest = model.ingest(events)
        if let announcement = ingest.preferredAnnouncement {
            lastAnnouncement = announcement
            announcementCount += 1
            sink.announce(announcement)
        }
        publish()
    }

    /// 流正常结束。
    public func onCompleted() {
        publish()
    }

    /// 流异常中断。
    public func onFaulted(_ error: Error) {
        model.finishStream()
        model.notice("这次没有收到回复，请稍后重试。")
        model.technical("流中断: \(String(describing: error))")
        publish()
    }

    /// 为本视图模型创建一个流泵（宿主负责 `start()`/`stop()`）。
    public func makePump(source: any StreamSource, maxEventsPerPull: Int = 32) -> StreamPump {
        StreamPump(
            source: source,
            maxEventsPerPull: maxEventsPerPull,
            onBatch: { [weak self] events in self?.ingest(events) },
            onCompleted: { [weak self] in self?.onCompleted() },
            onFailure: { [weak self] error in self?.onFaulted(error) })
    }

    private func publish() {
        snapshot = Self.makeSnapshot(model)
    }

    private static func makeSnapshot(_ model: UiModel) -> DesktopSnapshot {
        let degraded = model.degraded
        let isDegraded = degraded != nil
        let transcript: String
        if model.session.messages.isEmpty {
            transcript = isDegraded ? CompanionCopy.emptyOffline : CompanionCopy.emptyOnline
        } else {
            transcript = model.session.transcript
        }

        let degradedDetail = degraded.map { "\($0.detail) \($0.hint)" } ?? ""
        return DesktopSnapshot(
            density: model.density,
            windowTitle: model.density.windowTitle,
            heading: isDegraded ? CompanionCopy.headingOffline : CompanionCopy.headingOnline,
            transcript: transcript,
            streamingText: model.session.lastAssistantText ?? "",
            hintText: isDegraded ? degradedDetail : "",
            showHint: isDegraded,
            showRetry: isDegraded,
            isInputEnabled: model.connection.isOnline,
            statusText: isDegraded
                ? CompanionCopy.statusOffline
                : (model.session.streaming ? CompanionCopy.statusStreaming : CompanionCopy.statusOnline),
            isDegraded: isDegraded,
            degradedTitle: degraded?.title ?? "",
            degradedDetail: degradedDetail,
            isOnline: model.connection.isOnline,
            isStreaming: model.session.streaming,
            sessions: model.rows(of: UiModel.kindSession),
            workflows: model.rows(of: UiModel.kindWorkflow),
            approvals: model.rows(of: UiModel.kindApproval),
            tools: model.rows(of: UiModel.kindTool),
            auditRows: model.rows(of: UiModel.kindAudit),
            statusRows: model.rows(of: UiModel.kindStatus),
            conscienceBody: model.conscienceBody ?? "尚未读取良知锁定正文。",
            notices: model.notices,
            technicalLog: model.technicalLog)
    }
}
