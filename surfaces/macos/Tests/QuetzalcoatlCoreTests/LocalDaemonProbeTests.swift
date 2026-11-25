import Foundation
import Testing
@testable import QuetzalcoatlCore
import QuetzalcoatlInterop

@Suite("守护进程探测")
struct LocalDaemonProbeTests {
    private func makeHome() -> HomePaths {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("qz-probe-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return HomePaths(root: root.path)
    }

    private func writeRuntime(_ home: HomePaths, json: String, tokenMode: Int? = 0o600) throws {
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: home.runtimeInfoPath).deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Data(json.utf8).write(to: URL(fileURLWithPath: home.runtimeInfoPath))
        if let tokenMode {
            try Data(String(repeating: "a", count: 64).utf8)
                .write(to: URL(fileURLWithPath: home.tokenPath))
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
        try writeRuntime(home, json: #"{"pid":42,"ipc_http_addr":"127.0.0.1:4711"}"#, tokenMode: nil)
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

    @Test("有效运行时且有绑定时报告 pid 与端点")
    func validRuntimeWithBindingsReportsOnlinePidAndEndpoint() throws {
        let home = makeHome()
        defer { cleanup(home) }
        try writeRuntime(home, json: #"{"pid":4242,"ipc_http_addr":"127.0.0.1:4711"}"#)
        let result = LocalDaemonProbe.probe(home: home, bindingsAvailable: true)
        guard case .online(let pid, let endpoint, _) = result.connection else {
            Issue.record("期望在线，实际 \(result.connection)")
            return
        }
        #expect(pid == 4242)
        #expect(endpoint == "127.0.0.1:4711")
        #expect(result.bindingsAvailable)
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
