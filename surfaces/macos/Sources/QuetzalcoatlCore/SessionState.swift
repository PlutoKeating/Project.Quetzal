/// 会话内一条消息的角色。
public enum ChatRole: Sendable, Equatable {
    case user
    case assistant
    case system
}

/// 会话内一条消息。
public struct ChatLine: Sendable, Equatable {
    public var role: ChatRole
    public var text: String

    public init(role: ChatRole, text: String) {
        self.role = role
        self.text = text
    }
}

/// 当前会话与流状态（跨密度切换保持不变）。
public struct SessionState: Sendable, Equatable {
    public var threadID: String = "local"
    public var title: String = "当前会话"
    public var messages: [ChatLine] = []
    public var reasoning: String = ""
    public var streaming: Bool = false
    /// 已消费的最大事件序号（幂等去重）。
    public var lastSeq: UInt64 = 0

    public init() {}

    /// 面向人的完整对话文本（陪伴态直接展示）。
    public var transcript: String {
        messages.map { line in
            switch line.role {
            case .user: "你：\(line.text)"
            case .system: "· \(line.text)"
            case .assistant: line.text
            }
        }
        .joined(separator: "\n\n")
    }

    /// 追加一段助手正文增量（并入最后一条助手消息）。
    public mutating func appendAssistantDelta(_ text: String) {
        if var last = messages.last, last.role == .assistant {
            last.text += text
            messages[messages.count - 1] = last
            return
        }
        messages.append(ChatLine(role: .assistant, text: text))
    }

    /// 最近一条助手消息。
    public var lastAssistantText: String? {
        messages.last(where: { $0.role == .assistant })?.text
    }
}

/// 类型化降级原因。
public enum DegradedReason: String, Sendable, CaseIterable {
    case daemonUnavailable
    case insecureRuntimeFiles
    case ipcTransport
    case ipcRemote
    case bindingsUnavailable
}

/// 一段给用户看的降级说明（标题 + 一句解释 + 一个动作 + 技术原因）。
public struct DegradedView: Sendable, Equatable {
    public var title: String
    public var detail: String
    public var hint: String
    public var technical: String

    public init(title: String, detail: String, hint: String, technical: String) {
        self.title = title
        self.detail = detail
        self.hint = hint
        self.technical = technical
    }

    /// 供检视态单行展示的技术摘要。
    public var technicalLine: String { technical.isEmpty ? detail : technical }
}

/// 类型化错误的零术语文案表（与 Windows/C# 侧逐字一致）。
public enum DegradedCopy {
    public static func copy(for reason: DegradedReason, technical: String) -> DegradedView {
        switch reason {
        case .daemonUnavailable:
            DegradedView(
                title: "本机的 Quetzalcoatl 助手还没启动",
                detail: "这个窗口已经准备好了，只是暂时联系不上本机的助手。",
                hint: "在终端运行 quetzalcoatld，然后点下面的「重新连接」。",
                technical: technical)
        case .insecureRuntimeFiles:
            DegradedView(
                title: "助手的运行凭证权限不安全，已主动拒绝连接",
                detail: "为了保护你的数据，助手在凭证权限过宽时不会接受任何连接。",
                hint: "只允许你自己的账户读取运行凭证文件，然后重试。",
                technical: technical)
        case .ipcTransport:
            DegradedView(
                title: "本机助手暂时没有响应",
                detail: "助手可能正在重启，稍等一下再试就好。",
                hint: "点「重新连接」；如果一直这样，请重启 quetzalcoatld。",
                technical: technical)
        case .ipcRemote:
            DegradedView(
                title: "本机助手拒绝了这次请求",
                detail: "助手没有接受这次操作，你的原有数据没有变化。",
                hint: "确认操作对象后重试；也可以在「检视」里查看原因。",
                technical: technical)
        case .bindingsUnavailable:
            DegradedView(
                title: "这个版本还连不上本机助手",
                detail: "安装的版本里缺少与本机助手通讯的组件，界面本身可以正常使用。",
                hint: "安装完整版本后重新打开就可以连接。",
                technical: technical)
        }
    }
}

/// 与 `quetzalcoatld` 的连接状态。
public enum ConnectionState: Sendable, Equatable {
    case online(pid: UInt32, endpoint: String, spineEvents: Int)
    case offline(DegradedView)

    public var isOnline: Bool {
        if case .online = self { return true }
        return false
    }

    public var degraded: DegradedView? {
        if case .offline(let view) = self { return view }
        return nil
    }
}
