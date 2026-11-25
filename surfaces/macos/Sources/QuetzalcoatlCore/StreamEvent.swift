/// 流事件类别（与 UniFFI `FfiStreamEvent.kind` 字符串一一对应）。
public enum StreamEventKind: String, Sendable, Equatable {
    case delta
    case reasoning
    case toolCall = "tool_call"
    case done
    case error

    /// 把 UniFFI 的字符串类别解析为类型化枚举；未知类别显式失败。
    public init(label: String) throws {
        guard let kind = StreamEventKind(rawValue: label) else {
            throw StreamEventError.unknownKind(label)
        }
        self = kind
    }
}

/// 流事件解析错误。
public enum StreamEventError: Error, Equatable, Sendable {
    case unknownKind(String)
}

/// 一个拉模式流事件。
public struct StreamEvent: Sendable, Equatable {
    public var seq: UInt64
    public var kind: StreamEventKind
    public var text: String

    public init(seq: UInt64, kind: StreamEventKind, text: String) {
        self.seq = seq
        self.kind = kind
        self.text = text
    }
}

/// 播报类别：错误/审批类优先级高于普通正文增量。
public enum AnnouncementClass: Sendable, Equatable {
    case delta
    case error
    case approval
}

/// 一条待播报文本。
public struct Announcement: Sendable, Equatable {
    public var kind: AnnouncementClass
    public var text: String

    public init(kind: AnnouncementClass, text: String) {
        self.kind = kind
        self.text = text
    }
}

/// 一次流事件批次的消费结果。
public struct StreamIngest: Sendable, Equatable {
    public var applied: Int = 0
    public var deltas: String = ""
    public var announcements: [Announcement] = []

    public init() {}

    /// 每批只播一条：错误/审批类永远压过正文增量；同类别取最后一条。
    public var preferredAnnouncement: String? {
        announcements.last(where: { $0.kind == .error || $0.kind == .approval })?.text
            ?? announcements.last?.text
    }
}
