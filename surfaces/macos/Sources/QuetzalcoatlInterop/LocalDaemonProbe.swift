import Darwin
import Foundation
import QuetzalcoatlCore

/// 一次连接探测的完整结果。
public struct ProbeResult: Sendable {
    public let connection: ConnectionState
    public let bindingsAvailable: Bool
    public let tokenPresent: Bool
    public let technical: String

    public init(connection: ConnectionState, bindingsAvailable: Bool, tokenPresent: Bool, technical: String) {
        self.connection = connection
        self.bindingsAvailable = bindingsAvailable
        self.tokenPresent = tokenPresent
        self.technical = technical
    }
}

/// 本机 `quetzalcoatld` 探测：只读 `run/daemon.json` 与 `run/daemon.token`，
/// 先校验令牌权限（0600、属主为当前 UID）再触碰其内容；绝不打开脊柱。
public enum LocalDaemonProbe {
    public static func probe(home: HomePaths, bindingsAvailable: Bool) -> ProbeResult {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: home.runtimeInfoPath) else {
            return ProbeResult(
                connection: .offline(DegradedCopy.copy(
                    for: .daemonUnavailable,
                    technical: "daemon.json 不存在: \(home.runtimeInfoPath)")),
                bindingsAvailable: bindingsAvailable,
                tokenPresent: fileManager.fileExists(atPath: home.tokenPath),
                technical: "daemon.json 不存在: \(home.runtimeInfoPath)")
        }

        guard fileManager.fileExists(atPath: home.tokenPath) else {
            return ProbeResult(
                connection: .offline(DegradedCopy.copy(
                    for: .daemonUnavailable,
                    technical: "daemon.token 不存在: \(home.tokenPath)")),
                bindingsAvailable: bindingsAvailable,
                tokenPresent: false,
                technical: "daemon.token 不存在: \(home.tokenPath)")
        }

        if let privacyIssue = tokenPrivacyIssue(path: home.tokenPath) {
            return ProbeResult(
                connection: .offline(DegradedCopy.copy(for: .insecureRuntimeFiles, technical: privacyIssue)),
                bindingsAvailable: bindingsAvailable,
                tokenPresent: true,
                technical: privacyIssue)
        }

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: home.runtimeInfoPath)) else {
            return transportFailure("读取 daemon.json 失败", bindingsAvailable: bindingsAvailable)
        }

        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let runtime = object as? [String: Any]
        else {
            return transportFailure("解析 daemon.json 失败", bindingsAvailable: bindingsAvailable)
        }

        guard let pidNumber = runtime["pid"] as? NSNumber else {
            return transportFailure("daemon.json 缺少合法的 pid", bindingsAvailable: bindingsAvailable)
        }
        let pid = pidNumber.uint32Value
        let endpoint = runtime["ipc_http_addr"] as? String ?? "127.0.0.1:?"

        guard bindingsAvailable else {
            return ProbeResult(
                connection: .offline(DegradedCopy.copy(
                    for: .bindingsUnavailable,
                    technical: "未链接 QuetzalcoatlBindings 模块；以默认构建打开时无法建立拉模式流")),
                bindingsAvailable: false,
                tokenPresent: true,
                technical: "本构建没有 QuetzalcoatlBindings 模块")
        }

        return ProbeResult(
            connection: .online(pid: pid, endpoint: endpoint, spineEvents: 0),
            bindingsAvailable: true,
            tokenPresent: true,
            technical: "已发现本机守护进程 pid=\(pid) endpoint=\(endpoint)")
    }

    private static func transportFailure(_ detail: String, bindingsAvailable: Bool) -> ProbeResult {
        ProbeResult(
            connection: .offline(DegradedCopy.copy(for: .ipcTransport, technical: detail)),
            bindingsAvailable: bindingsAvailable,
            tokenPresent: true,
            technical: detail)
    }

    /// 令牌必须是普通文件、权限不含 group/other 位、属主为当前有效 UID。
    private static func tokenPrivacyIssue(path: String) -> String? {
        let url = URL(fileURLWithPath: path)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else {
            return "无法读取令牌元数据: \(path)"
        }
        if let type = attributes[.type] as? FileAttributeType, type != .typeRegular {
            return "令牌不是普通文件: \(path)"
        }
        if let permissions = attributes[.posixPermissions] as? NSNumber {
            let mode = permissions.uint16Value
            if mode & 0o077 != 0 {
                return String(format: "令牌权限过宽 (mode=0o%o, 需要 0600): %@", mode, path)
            }
        }
        if let owner = attributes[.ownerAccountID] as? NSNumber, owner.uint32Value != getuid() {
            return "令牌属主 uid=\(owner.uint32Value) 与当前有效 uid=\(getuid()) 不一致: \(path)"
        }
        return nil
    }
}
