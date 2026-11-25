import Darwin
import Foundation
import QuetzalcoatlCore

/// 本机守护进程 `status` 握手的应答（只保留桌面端需要的字段）。
public struct DaemonStatusReply: Sendable, Equatable {
    public let pid: UInt32
    public let spineEvents: Int

    public init(pid: UInt32, spineEvents: Int) {
        self.pid = pid
        self.spineEvents = spineEvents
    }
}

/// 令牌认证的 `status` 握手传输层；测试可注入桩以覆盖成功路径。
public protocol StatusTransport: Sendable {
    /// 执行一次带令牌的 `status` 调用；任何失败返回 `nil`。
    func fetchStatus(endpoint: String, token: String) throws -> DaemonStatusReply?
}

/// 默认传输：`POST http://<ipc_http_addr>/v1/rpc`，请求头 `x-qz-ipc-token`，2s 超时。
public struct URLSessionStatusTransport: StatusTransport {
    public init() {}

    public func fetchStatus(endpoint: String, token: String) throws -> DaemonStatusReply? {
        guard let url = URL(string: "http://\(endpoint)/v1/rpc") else {
            return nil
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 2
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-qz-ipc-token")
        request.httpBody = Data(#"{"method":"status"}"#.utf8)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 2
        let session = URLSession(configuration: configuration)

        final class Box: @unchecked Sendable {
            var data: Data?
            var error: Error?
        }
        let box = Box()
        let semaphore = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { data, _, error in
            box.data = data
            box.error = error
            semaphore.signal()
        }
        .resume()

        guard semaphore.wait(timeout: .now() + 3) == .success else {
            session.invalidateAndCancel()
            return nil
        }
        session.finishTasksAndInvalidate()

        if box.error != nil {
            return nil
        }
        guard
            let data = box.data,
            let object = try? JSONSerialization.jsonObject(with: data),
            let root = object as? [String: Any],
            root["kind"] as? String == "status",
            let payload = root["data"] as? [String: Any],
            let pidNumber = payload["pid"] as? NSNumber
        else {
            return nil
        }

        let spineEvents = (payload["spine_events_count"] as? NSNumber)?.intValue ?? 0
        return DaemonStatusReply(pid: pidNumber.uint32Value, spineEvents: spineEvents)
    }
}

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

/// 本机 `quetzalcoatld` 探测：只读 `run/daemon.json` 与权限校验后的 `run/daemon.token`，
/// 并且**必须**完成令牌认证的 `status` 握手才会报告在线；绝不因为「文件存在」就宣称已连接。
public enum LocalDaemonProbe {
    private static let tokenHexLength = 64

    public static func probe(
        home: HomePaths,
        bindingsAvailable: Bool,
        transport: any StatusTransport = URLSessionStatusTransport()
    ) -> ProbeResult {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: home.runtimeInfoPath) else {
            return offline(.daemonUnavailable, bindingsAvailable, fileManager.fileExists(atPath: home.tokenPath),
                           "daemon.json 不存在: \(home.runtimeInfoPath)")
        }

        guard fileManager.fileExists(atPath: home.tokenPath) else {
            return offline(.daemonUnavailable, bindingsAvailable, false, "daemon.token 不存在: \(home.tokenPath)")
        }

        if let privacyIssue = tokenPrivacyIssue(path: home.tokenPath) {
            return offline(.insecureRuntimeFiles, bindingsAvailable, true, privacyIssue)
        }

        guard let tokenData = try? Data(contentsOf: URL(fileURLWithPath: home.tokenPath)),
              let rawToken = String(data: tokenData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        else {
            return unverified(pid: 0, endpoint: "?", bindingsAvailable, "读取令牌失败")
        }

        guard rawToken.count == tokenHexLength,
              rawToken.allSatisfy({ $0.isHexDigit })
        else {
            return unverified(pid: 0, endpoint: "?", bindingsAvailable, "IPC 令牌格式非法（应为 64 位十六进制）")
        }

        guard let data = try? Data(contentsOf: URL(fileURLWithPath: home.runtimeInfoPath)) else {
            return offline(.ipcTransport, bindingsAvailable, true, "读取 daemon.json 失败")
        }

        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let runtime = object as? [String: Any],
            let pidNumber = runtime["pid"] as? NSNumber
        else {
            return offline(.ipcTransport, bindingsAvailable, true, "解析 daemon.json 失败")
        }
        let pid = pidNumber.uint32Value
        let endpoint = runtime["ipc_http_addr"] as? String ?? "127.0.0.1:?"

        guard bindingsAvailable else {
            // 本构建没有原生传输：即使守护进程在线也无法建立拉模式流，如实报告。
            return offline(.bindingsUnavailable, false, true,
                           "未链接 QuetzalcoatlBindings 模块；以默认构建打开时无法建立拉模式流")
        }

        guard processIsAlive(pid) else {
            return unverified(pid: pid, endpoint: endpoint, bindingsAvailable, "daemon.json 的 pid=\(pid) 已退出（陈旧运行时文件）")
        }

        let reply: DaemonStatusReply?
        do {
            reply = try transport.fetchStatus(endpoint: endpoint, token: rawToken)
        } catch {
            reply = nil
        }
        guard let reply else {
            return unverified(pid: pid, endpoint: endpoint, bindingsAvailable, "令牌认证的 status 握手失败（\(endpoint)）")
        }
        guard reply.pid == pid else {
            return unverified(pid: pid, endpoint: endpoint, bindingsAvailable,
                              "status 返回的 pid=\(reply.pid) 与 daemon.json 的 pid=\(pid) 不一致")
        }

        return ProbeResult(
            connection: .online(pid: pid, endpoint: endpoint, spineEvents: reply.spineEvents),
            bindingsAvailable: true,
            tokenPresent: true,
            technical: "已通过令牌认证握手：pid=\(pid) endpoint=\(endpoint) spine_events=\(reply.spineEvents)")
    }

    private static func processIsAlive(_ pid: UInt32) -> Bool {
        guard pid != 0 else { return false }
        errno = 0
        let result = kill(pid_t(pid), 0)
        return result == 0 || errno == EPERM
    }

    private static func offline(
        _ reason: DegradedReason,
        _ bindingsAvailable: Bool,
        _ tokenPresent: Bool,
        _ technical: String
    ) -> ProbeResult {
        ProbeResult(
            connection: .offline(DegradedCopy.copy(for: reason, technical: technical)),
            bindingsAvailable: bindingsAvailable,
            tokenPresent: tokenPresent,
            technical: technical)
    }

    private static func unverified(
        pid: UInt32,
        endpoint: String,
        _ bindingsAvailable: Bool,
        _ technical: String
    ) -> ProbeResult {
        ProbeResult(
            connection: .detectedUnverified(pid: pid, endpoint: endpoint, reason: technical),
            bindingsAvailable: bindingsAvailable,
            tokenPresent: true,
            technical: technical)
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
