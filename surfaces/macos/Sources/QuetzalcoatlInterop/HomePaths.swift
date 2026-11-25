import Foundation

/// Quetzalcoatl 家目录解析（POSIX 默认 `~/.quetzalcoatl`，遵循 AGENTS.md）。
public struct HomePaths: Sendable, Equatable {
    public let root: String

    public init(root: String) {
        self.root = root
    }

    /// 解析顺序：显式参数 → `QUETZALCOATL_HOME` → `~/.quetzalcoatl`。
    public static func resolve(explicit: String? = nil) -> HomePaths {
        if let explicit, !explicit.isEmpty {
            return HomePaths(root: URL(fileURLWithPath: explicit).standardizedFileURL.path)
        }
        if let home = ProcessInfo.processInfo.environment["QUETZALCOATL_HOME"], !home.isEmpty {
            return HomePaths(root: URL(fileURLWithPath: home).standardizedFileURL.path)
        }
        return HomePaths(root: URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".quetzalcoatl").path)
    }

    /// 守护进程运行时描述文件。
    public var runtimeInfoPath: String {
        URL(fileURLWithPath: root).appendingPathComponent("run/daemon.json").path
    }

    /// 本地连接令牌。
    public var tokenPath: String {
        URL(fileURLWithPath: root).appendingPathComponent("run/daemon.token").path
    }

    /// 脊柱独占锁（薄客户端只探测存在性，绝不打开脊柱）。
    public var spineLockPath: String {
        URL(fileURLWithPath: root).appendingPathComponent("spine/daemon.lock").path
    }

    /// 桌面端偏好文件。
    public var preferencesPath: String {
        URL(fileURLWithPath: root).appendingPathComponent("desktop.json").path
    }
}
