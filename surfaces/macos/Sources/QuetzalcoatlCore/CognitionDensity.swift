/// 视图披露层级（严格嵌套：summary ⊂ detail ⊂ raw）。
public enum DetailLayer: Sendable, Equatable {
    case summary
    case detail
    case raw
}

/// 三档认知密度。
public enum CognitionDensity: String, CaseIterable, Sendable, Codable, Equatable {
    /// 陪伴态：零术语、≥64pt 触点。
    case companion
    /// 工作台态：摘要 + 细节，桌面默认。
    case workbench
    /// 检视态：摘要 + 细节 + 原始载荷。
    case inspector

    /// 稳定的英文标识（偏好文件与无障碍标识使用）。
    public var label: String { rawValue }

    /// 面向人的页面标题。
    public var title: String {
        switch self {
        case .companion: "陪伴"
        case .workbench: "工作台"
        case .inspector: "检视"
        }
    }

    /// 窗口标题。
    public var windowTitle: String { "Quetzalcoatl · \(title)" }

    /// 菜单/工具栏快捷键提示（真实快捷键由 `Button.keyboardShortcut` 注册）。
    public var shortcut: String {
        switch self {
        case .companion: "⌘1"
        case .workbench: "⌘2"
        case .inspector: "⌘3"
        }
    }

    /// 该密度允许披露的层级（与 Rust `CognitionDensity::includes` 逐条一致）。
    public func includes(_ layer: DetailLayer) -> Bool {
        switch layer {
        case .summary:
            true
        case .detail:
            self != .companion
        case .raw:
            self == .inspector
        }
    }
}
