import Foundation

/// 桌面端 UI 模型：三档认知密度的差分视图 + 会话/流状态 + 类型化连接状态。
///
/// 该值类型完全由拉模式流事件与补丁驱动，自身不持有任何数据库连接；
/// macOS 端只经 `QuetzalcoatlInterop` 的 UniFFI 薄接口访问守护进程，绝不打开脊柱。
public struct UiModel: Sendable, Equatable {
    public static let kindSession = "session"
    public static let kindProject = "project"
    public static let kindApproval = "approval"
    public static let kindWorkflow = "workflow"
    public static let kindConscience = "conscience"
    public static let kindTool = "tool"
    public static let kindAudit = "audit"
    public static let kindStatus = "status"

    public private(set) var view: ViewState
    public var session: SessionState
    public var connection: ConnectionState
    public var notices: [String]
    public var technicalLog: [String]
    public var conscienceBody: String?

    public init(view: ViewState, connection: ConnectionState) {
        self.view = view
        self.session = SessionState()
        self.connection = connection
        self.notices = []
        self.technicalLog = []
        self.conscienceBody = nil
    }

    /// 离线模型（无守护进程时不静默直连数据库）。
    public static func offline(
        _ reason: String,
        density: CognitionDensity = .workbench
    ) -> UiModel {
        UiModel(
            view: ViewState(rev: 0, density: density),
            connection: .offline(DegradedCopy.copy(for: .daemonUnavailable, technical: reason)))
    }

    /// 在线模型。
    public static func online(
        pid: UInt32,
        endpoint: String,
        spineEvents: Int,
        density: CognitionDensity
    ) -> UiModel {
        UiModel(
            view: ViewState(rev: 0, density: density),
            connection: .online(pid: pid, endpoint: endpoint, spineEvents: spineEvents))
    }

    /// 以任意类型化连接状态构造（探测结果直接驱动，绝不伪造在线）。
    public static func fromConnection(_ connection: ConnectionState, density: CognitionDensity) -> UiModel {
        UiModel(view: ViewState(rev: 0, density: density), connection: connection)
    }

    public var density: CognitionDensity { view.density }
    public var degraded: DegradedView? { connection.degraded }

    public mutating func applyPatch(_ patch: ViewPatch) throws {
        try view.apply(patch)
    }

    /// 切换密度：只推进一个纯密度补丁修订，绝不动任何行或会话状态。
    @discardableResult
    public mutating func setDensity(_ density: CognitionDensity) -> Bool {
        guard view.density != density else { return false }
        do {
            try view.apply(view.densityPatch(density))
            return true
        } catch {
            return false
        }
    }

    /// 消费一批拉模式流事件（幂等：重复批次不会重复追加正文）。
    public mutating func ingest(_ events: [StreamEvent]) -> StreamIngest {
        var ingest = StreamIngest()
        for event in events {
            if event.seq != 0 {
                if event.seq <= session.lastSeq { continue }
                session.lastSeq = event.seq
            }
            ingest.applied += 1
            switch event.kind {
            case .delta:
                session.streaming = true
                session.appendAssistantDelta(event.text)
                ingest.deltas += event.text
            case .reasoning:
                session.reasoning += event.text
            case .toolCall:
                session.messages.append(ChatLine(role: .system, text: "工具：\(event.text)"))
            case .done:
                session.streaming = false
            case .error:
                session.streaming = false
                session.messages.append(ChatLine(role: .system, text: "出错了：\(event.text)"))
                ingest.announcements.append(
                    Announcement(kind: .error, text: "本轮出错了：\(event.text)"))
            }
        }

        if !ingest.deltas.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ingest.announcements.append(
                Announcement(kind: .delta, text: Self.tail(ingest.deltas, limit: 80)))
        }
        return ingest
    }

    /// 追加用户消息（本地回显）。
    public mutating func pushUserMessage(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        session.messages.append(ChatLine(role: .user, text: text))
    }

    /// 收束当前流。
    public mutating func finishStream() {
        session.streaming = false
    }

    /// 记录一条本地提示（零术语）。
    public mutating func notice(_ text: String) {
        notices.append(text)
    }

    /// 记录一条技术细节（仅检视态展示）。
    public mutating func technical(_ text: String) {
        technicalLog.append(text)
    }

    /// 按当前密度投影出指定种类的行。
    public func rows(of kind: String) -> [ViewRow] {
        view.projectedRows(view.density)
            .filter { $0.kind == kind || $0.key == kind }
    }

    private static func tail(_ text: String, limit: Int) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        return String(trimmed.suffix(limit))
    }
}
