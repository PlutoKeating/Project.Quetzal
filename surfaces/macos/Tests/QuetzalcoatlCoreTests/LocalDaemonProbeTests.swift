import Darwin
import Foundation
import Testing
@testable import QuetzalcoatlCore
import QuetzalcoatlInterop

private struct StubTransport: StatusTransport {
    let reply: DaemonStatusReply?
    func fetchStatus(endpoint: String, token: String) throws -> DaemonStatusReply? {
        _ = endpoint
        _ = token
        return reply
    }
}

@Suite("守护进程探测")
struct LocalDaemonProbeTests {
    private func makeHome() -> HomePaths {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("qz-probe-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return HomePaths(root: root.path)
    }

    private func writeRuntime(
        _ home: HomePaths,
        json: String,
        token: String? = String(repeating: "a", count: 64),
        tokenMode: Int = 0o600
    ) throws {
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: home.runtimeInfoPath).deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Data(json.utf8).write(to: URL(fileURLWithPath: home.runtimeInfoPath))
        if let token {
            try Data(token.utf8).write(to: URL(fileURLWithPath: home.tokenPath))
            try FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: tokenMode)],
                ofItemAtPath: home.tokenPath)
        }
    }

    private func cleanup(_ home: HomePaths) {
        try? FileManager.default.removeItem(at: URL(fileURLWithPath: home.root))
    }

    @Test("运行时文件缺失时降级为未启动")
    func missingRuntimeFilesDegradeToDaemonUnavailable() {
        let home = makeHome()
        defer { cleanup(home) }
        let result = LocalDaemonProbe.probe(home: home, bindingsAvailable: false)
        #expect(!result.connection.isOnline)
        #expect(result.connection.degraded?.title == "本机的 Quetzalcoatl 助手还没启动")
        #expect(!result.tokenPresent)
    }

    @Test("令牌缺失时降级而不是连接")
    func missingTokenDegradesInsteadOfConnecting() throws {
        let home = makeHome()
        defer { cleanup(home) }
        try writeRuntime(home, json: #"{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}"#, token: nil)
        let result = LocalDaemonProbe.probe(home: home, bindingsAvailable: true)
        #expect(!result.connection.isOnline)
        #expect(!result.tokenPresent)
    }

    @Test("权限过宽的令牌被主动拒绝")
    func worldReadableTokenIsRejected() throws {
        let home = makeHome()
        defer { cleanup(home) }
        try writeRuntime(home, json: #"{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}"#, tokenMode: 0o644)
        let result = LocalDaemonProbe.probe(home: home, bindingsAvailable: true)
        #expect(!result.connection.isOnline)
        #expect(result.connection.degraded?.title == "助手的运行凭证权限不安全，已主动拒绝连接")
        #expect(result.technical.contains("权限过宽"))
    }

    @Test("有效运行时但无绑定时报类型化缺失")
    func validRuntimeWithoutBindingsReportsTypedBindingsUnavailable() throws {
        let home = makeHome()
        defer { cleanup(home) }
        try writeRuntime(home, json: #"{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}"#)
        let result = LocalDaemonProbe.probe(home: home, bindingsAvailable: false)
        #expect(!result.connection.isOnline)
        #expect(result.tokenPresent)
        #expect(result.connection.degraded?.title == "这个版本还连不上本机助手")
    }

    @Test("令牌认证握手通过且 pid 一致才报告在线")
    func validRuntimeWithAuthenticatedHandshakeReportsOnline() throws {
        let home = makeHome()
        defer { cleanup(home) }
        let pid = UInt32(getpid())
        try writeRuntime(home, json: #"{"pid":\#(pid),"ipc_http_addr":"127.0.0.1:4711"}"#)
        let result = LocalDaemonProbe.probe(
            home: home,
            bindingsAvailable: true,
            transport: StubTransport(reply: DaemonStatusReply(pid: pid, spineEvents: 42)))
        guard case .online(let echoedPid, let endpoint, let spineEvents) = result.connection else {
            Issue.record("期望在线，实际 \(result.connection)")
            return
        }
        #expect(echoedPid == pid)
        #expect(endpoint == "127.0.0.1:4711")
        #expect(spineEvents == 42)
    }

    @Test("陈旧 daemon.json（pid 已退出）降级为未验证而不是在线")
    func staleRuntimeWithDeadPidIsDetectedUnverified() throws {
        let home = makeHome()
        defer { cleanup(home) }
        try writeRuntime(home, json: #"{"pid":4000000,"ipc_http_addr":"127.0.0.1:4711"}"#)
        let result = LocalDaemonProbe.probe(
            home: home,
            bindingsAvailable: true,
            transport: StubTransport(reply: DaemonStatusReply(pid: 4_000_000, spineEvents: 0)))
        guard case .detectedUnverified = result.connection else {
            Issue.record("期望 detectedUnverified，实际 \(result.connection)")
            return
        }
        #expect(!result.connection.isOnline)
        #expect(result.connection.degraded?.title == "找到了本机助手，但还没通过验证")
        #expect(result.technical.contains("已退出"))
    }

    @Test("错误令牌导致握手失败时降级为未验证")
    func wrongTokenIsDetectedUnverified() throws {
        let home = makeHome()
        defer { cleanup(home) }
        let pid = UInt32(getpid())
        try writeRuntime(home, json: #"{"pid":\#(pid),"ipc_http_addr":"127.0.0.1:4711"}"#)
        let result = LocalDaemonProbe.probe(
            home: home,
            bindingsAvailable: true,
            transport: StubTransport(reply: nil))
        guard case .detectedUnverified = result.connection else {
            Issue.record("期望 detectedUnverified，实际 \(result.connection)")
            return
        }
        #expect(!result.connection.isOnline)
        #expect(result.technical.contains("握手失败"))
    }

    @Test("status 返回的 pid 与运行时文件不一致时降级为未验证")
    func mismatchedPidIsDetectedUnverified() throws {
        let home = makeHome()
        defer { cleanup(home) }
        let pid = UInt32(getpid())
        try writeRuntime(home, json: #"{"pid":\#(pid),"ipc_http_addr":"127.0.0.1:4711"}"#)
        let result = LocalDaemonProbe.probe(
            home: home,
            bindingsAvailable: true,
            transport: StubTransport(reply: DaemonStatusReply(pid: pid + 1, spineEvents: 0)))
        guard case .detectedUnverified = result.connection else {
            Issue.record("期望 detectedUnverified，实际 \(result.connection)")
            return
        }
    }

    @Test("非法令牌格式被拒绝且不发起握手")
    func malformedTokenIsRejectedBeforeHandshake() throws {
        let home = makeHome()
        defer { cleanup(home) }
        try writeRuntime(home, json: #"{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}"#, token: "not-a-token")
        let result = LocalDaemonProbe.probe(
            home: home,
            bindingsAvailable: true,
            transport: StubTransport(reply: DaemonStatusReply(pid: 42, spineEvents: 0)))
        guard case .detectedUnverified = result.connection else {
            Issue.record("期望 detectedUnverified，实际 \(result.connection)")
            return
        }
        #expect(result.technical.contains("令牌格式非法"))
    }

    @Test("损坏的运行时文件降级为传输错误并带技术细节")
    func malformedRuntimeDegradesToTransportCopyWithTechnicalDetail() throws {
        let home = makeHome()
        defer { cleanup(home) }
        try writeRuntime(home, json: "{ broken")
        let result = LocalDaemonProbe.probe(home: home, bindingsAvailable: true)
        #expect(!result.connection.isOnline)
        #expect(result.technical.contains("解析"))
    }

    @Test("家目录默认回落到 .quetzalcoatl")
    func homePathDefaultsToDotQuetzalcoatlWhenEnvironmentIsUnset() {
        let resolved = HomePaths.resolve(explicit: nil)
        let environment = ProcessInfo.processInfo.environment["QUETZALCOATL_HOME", default: ""]
        #expect(resolved.root.hasSuffix(".quetzalcoatl") || !environment.isEmpty)
    }
}
