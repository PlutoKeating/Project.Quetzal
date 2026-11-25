import Foundation

/// 桌面端持久偏好（密度、窗口尺寸、菜单栏驻留与登录自启）。
public struct DesktopPreferences: Codable, Sendable, Equatable {
    public var density: CognitionDensity = .workbench
    public var width: Double = 1180
    public var height: Double = 780
    public var maximized: Bool = false
    public var closeToMenuBar: Bool = true
    public var startAtLogin: Bool = false

    public init() {}

    /// 把明显非法的尺寸收敛到可用范围。
    public func sanitized() -> DesktopPreferences {
        var copy = self
        copy.width = min(max(width, 320), 8192)
        copy.height = min(max(height, 240), 8192)
        return copy
    }
}

/// 偏好的原子读写（`Data.write(.atomic)`；损坏或缺失整体回退默认值）。
public struct PreferencesStore: Sendable {
    public let path: String

    public init(path: String) {
        self.path = path
    }

    /// 默认路径：`QUETZALCOATL_HOME/desktop.json`，否则 `~/Library/Application Support/Quetzalcoatl/desktop.json`。
    public static func defaultPath() -> String {
        if let home = ProcessInfo.processInfo.environment["QUETZALCOATL_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home).appendingPathComponent("desktop.json").path
        }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
        return base.appendingPathComponent("Quetzalcoatl").appendingPathComponent("desktop.json").path
    }

    /// 读取偏好；缺失、损坏或字段非法时整体回退默认值。
    public func load() -> DesktopPreferences {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            return DesktopPreferences()
        }
        guard let decoded = try? JSONDecoder().decode(DesktopPreferences.self, from: data) else {
            return DesktopPreferences()
        }
        return decoded.sanitized()
    }

    /// 原子写盘。
    public func save(_ preferences: DesktopPreferences) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(preferences.sanitized())
        try data.write(to: url, options: .atomic)
    }
}

/// launchd 生命周期支持：生成用户级 LaunchAgent plist（等价 Linux 用户 unit / Windows 登录自启）。
public enum LaunchdSupport {
    /// 生成 LaunchAgent plist 文本。
    public static func agentPlist(executablePath: String, home: String?, label: String = "org.quetzalcoatl.macos") -> String {
        let homeEntry: String
        if let home, !home.isEmpty {
            homeEntry = """
                    <key>QUETZALCOATL_HOME</key>
                    <string>\(escape(home))</string>
            """
        } else {
            homeEntry = ""
        }

        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>\(escape(label))</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(escape(executablePath))</string>
                <string>--menu-bar-only</string>
            </array>
            <key>RunAtLoad</key>
            <true/>
            <key>KeepAlive</key>
            <dict>
                <key>SuccessfulExit</key>
                <false/>
            </dict>
            <key>ThrottleInterval</key>
            <integer>10</integer>
            <key>ProcessType</key>
            <string>Interactive</string>
            <key>EnvironmentVariables</key>
            <dict>
        \(homeEntry)
            </dict>
            <key>StandardOutPath</key>
            <string>\(escape(defaultLogPath()))</string>
            <key>StandardErrorPath</key>
            <string>\(escape(defaultLogPath()))</string>
        </dict>
        </plist>
        """
    }

    /// 安装提示（不自动写入用户目录，避免未经确认修改系统状态）。
    public static func installHint(executablePath: String) -> String {
        let plist = agentPlist(executablePath: executablePath, home: nil)
        return """
        把以下内容保存为 ~/Library/LaunchAgents/org.quetzalcoatl.macos.plist，然后执行：
          launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.quetzalcoatl.macos.plist

        \(plist)
        """
    }

    private static func defaultLogPath() -> String {
        let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
        return base.appendingPathComponent("Logs/Quetzalcoatl/macos.log").path
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
