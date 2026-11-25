import Foundation

/// 无障碍控件类型（用于静态契约与 SwiftUI 原生控件对照）。
public enum ControlKind: String, Sendable, Equatable {
    case window
    case staticText
    case textField
    case button
    case list
    case tab
    case menuItem
}

/// 一个交互控件的无障碍契约条目。
///
/// - `nameIsContent == true`：内容承载控件（对话正文/标题/状态/说明），SwiftUI 源码
///   **不得**给它设置 `.accessibilityLabel`，否则 VoiceOver 会朗读区块标签而不是真实内容；
///   区块说明只能放在 `.accessibilityHint` 或标识符里。
/// - `isDynamicId == true`：行级控件，真实标识符是 `id/行 key`，前缀必须出现在源码里。
public struct AccessibilityControl: Sendable, Equatable {
    public let id: String
    public let label: String
    public let kind: ControlKind
    public let isInteractive: Bool
    public let minTarget: Double
    public let hint: String
    public let nameIsContent: Bool
    public let isDynamicId: Bool

    public init(
        id: String,
        label: String,
        kind: ControlKind,
        isInteractive: Bool = false,
        minTarget: Double = 0,
        hint: String = "",
        nameIsContent: Bool = false,
        isDynamicId: Bool = false
    ) {
        self.id = id
        self.label = label
        self.kind = kind
        self.isInteractive = isInteractive
        self.minTarget = minTarget
        self.hint = hint
        self.nameIsContent = nameIsContent
        self.isDynamicId = isDynamicId
    }
}

/// macOS 端无障碍契约：SwiftUI 的 `.accessibilityIdentifier` / `.accessibilityLabel`
/// 必须与此清单逐条一致；单测直接扫描真实 SwiftUI 源码，杜绝「界面改了、测试没跟上」。
public enum AccessibilityCatalog {
    public static let all: [AccessibilityControl] = [
        AccessibilityControl(id: "shell.root", label: "Quetzalcoatl 桌面", kind: .window),
        AccessibilityControl(id: "nav.density", label: "视图密度", kind: .tab, isInteractive: true),
        AccessibilityControl(id: "tab.companion", label: "陪伴视图（⌘1）", kind: .tab, isInteractive: true),
        AccessibilityControl(id: "tab.workbench", label: "工作台视图（⌘2）", kind: .tab, isInteractive: true),
        AccessibilityControl(id: "tab.inspector", label: "检视视图（⌘3）", kind: .tab, isInteractive: true),
        AccessibilityControl(id: "status.connection", label: "连接状态提示", kind: .staticText, nameIsContent: true),
        AccessibilityControl(id: "status.degraded", label: "未连接说明", kind: .staticText, nameIsContent: true),
        AccessibilityControl(id: "companion.heading", label: "陪伴视图标题", kind: .staticText, nameIsContent: true),
        AccessibilityControl(
            id: "companion.transcript",
            label: CompanionCopy.transcriptLabel,
            kind: .staticText,
            hint: CompanionCopy.transcriptHint,
            nameIsContent: true),
        AccessibilityControl(id: "companion.hint", label: "未连接时的说明", kind: .staticText, nameIsContent: true),
        AccessibilityControl(
            id: "companion.entry",
            label: CompanionCopy.entryLabel,
            kind: .textField,
            isInteractive: true,
            minTarget: 64,
            hint: CompanionCopy.entryHint),
        AccessibilityControl(
            id: "companion.send",
            label: "发送这句话",
            kind: .button,
            isInteractive: true,
            minTarget: 64),
        AccessibilityControl(
            id: "companion.retry",
            label: "重新连接本机助手",
            kind: .button,
            isInteractive: true,
            minTarget: 64),
        AccessibilityControl(id: "companion.status", label: "连接状态", kind: .staticText, nameIsContent: true),
        AccessibilityControl(id: "workbench.transcript", label: "工作台对话内容", kind: .staticText, nameIsContent: true),
        AccessibilityControl(id: "workbench.entry", label: "工作台输入框", kind: .textField, isInteractive: true, minTarget: 32),
        AccessibilityControl(id: "workbench.send", label: "工作台发送按钮", kind: .button, isInteractive: true, minTarget: 32),
        AccessibilityControl(id: "workbench.workflows", label: "工作流列表", kind: .list),
        AccessibilityControl(id: "workbench.approvals", label: "待批准操作列表", kind: .list),
        AccessibilityControl(
            id: "workbench.approve",
            label: "批准这项操作",
            kind: .button,
            isInteractive: true,
            minTarget: 32,
            isDynamicId: true),
        AccessibilityControl(
            id: "workbench.deny",
            label: "拒绝这项操作",
            kind: .button,
            isInteractive: true,
            minTarget: 32,
            isDynamicId: true),
        AccessibilityControl(id: "inspector.conscience", label: "良知锁定正文", kind: .staticText, nameIsContent: true),
        AccessibilityControl(id: "inspector.tools", label: "工具调用列表", kind: .list),
        AccessibilityControl(id: "inspector.audit", label: "审计事件列表", kind: .list),
        AccessibilityControl(id: "inspector.technical", label: "运行技术日志", kind: .list),
        AccessibilityControl(id: "inspector.pump", label: "流泵统计", kind: .staticText, nameIsContent: true),
        AccessibilityControl(id: "menu.show", label: "显示 Quetzalcoatl 主窗口", kind: .menuItem, isInteractive: true),
        AccessibilityControl(id: "menu.quit", label: "退出 Quetzalcoatl", kind: .menuItem, isInteractive: true),
    ]

    /// 结构性自检：ID 唯一、名称非空、可交互控件有最小触点、陪伴态触点 ≥64pt。
    public static func validateStructure() -> [String] {
        var issues: [String] = []
        var seen = Set<String>()
        for control in all {
            if control.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                issues.append("存在空 id 的契约条目")
                continue
            }
            if !seen.insert(control.id).inserted {
                issues.append("\(control.id): id 重复")
            }
            if control.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                issues.append("\(control.id): 无障碍名称不能为空")
            }
            if control.isInteractive && control.kind != .tab && control.kind != .menuItem && control.minTarget == 0 {
                issues.append("\(control.id): 可交互控件必须声明最小触点")
            }
            if control.isInteractive && control.id.hasPrefix("companion.") && control.minTarget < 64 {
                issues.append("\(control.id): 陪伴态触点不得小于 64pt（实际 \(control.minTarget)pt）")
            }
            if control.nameIsContent && (control.kind == .button || control.kind == .textField) {
                issues.append("\(control.id): 交互控件不能声明为内容承载（会丢失可操作名称）")
            }
        }
        return issues
    }
}
