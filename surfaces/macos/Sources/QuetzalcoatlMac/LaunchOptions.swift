import Foundation
import QuetzalcoatlCore
import QuetzalcoatlInterop

/// 启动参数（自检、演示数据、菜单栏驻留与产物报告）。
public struct LaunchOptions: Sendable {
    public var home: String?
    public var reportPath: String?
    public var selfTest = false
    public var demoRows = false
    public var demoStream = 0
    public var menuBarOnly = false
    public var printLaunchAgent = false

    /// 解析命令行参数；未知参数忽略。
    public static func parse(_ arguments: [String]) -> LaunchOptions {
        var options = LaunchOptions()
        var index = 0
        while index < arguments.count {
            switch arguments[index] {
            case "--home" where index + 1 < arguments.count:
                index += 1
                options.home = arguments[index]
            case "--report" where index + 1 < arguments.count:
                index += 1
                options.reportPath = arguments[index]
            case "--demo-stream" where index + 1 < arguments.count:
                index += 1
                if let count = Int(arguments[index]), count > 0 {
                    options.demoStream = count
                }
            case "--self-test":
                options.selfTest = true
            case "--demo-rows":
                options.demoRows = true
            case "--menu-bar-only":
                options.menuBarOnly = true
            case "--print-launch-agent":
                options.printLaunchAgent = true
            default:
                break
            }
            index += 1
        }
        return options
    }
}

/// 无头自检：只依赖 Core/Interop（不创建 NSApplication），可在无窗口会话中运行。
public enum SelfTest {
    /// 运行自检并返回退出码（0 = 通过）。
    @MainActor
    public static func run(options: LaunchOptions) -> Int32 {
        let home = HomePaths.resolve(explicit: options.home)
        let probe = LocalDaemonProbe.probe(home: home, bindingsAvailable: StreamSourceFactory.bindingsAvailable)
        var model = UiModel.fromConnection(probe.connection, density: .workbench)
        model.technical(probe.technical)
        if options.demoRows {
            try? DemoData.apply(to: &model)
        }

        final class NullSink: AnnouncementSink {
            func announce(_ text: String) {}
        }

        let viewModel = DesktopViewModel(model: model, sink: NullSink())
        viewModel.ingest([
            StreamEvent(seq: 1, kind: .delta, text: "自检"),
            StreamEvent(seq: 2, kind: .done, text: "done"),
        ])
        viewModel.applyDensity(.inspector)

        let connected = viewModel.snapshot.isOnline
        let degraded = viewModel.snapshot.isDegraded
        let bindings = probe.bindingsAvailable
        let rows = model.view.rowCount
        let announcements = viewModel.announcementCount
        let density = viewModel.density.label
        let expectedRows = options.demoRows ? 6 : 0
        let ok = !connected && degraded && density == "inspector" && rows == expectedRows && announcements == 1
        let line = "\(ok ? "MAC_SELF_TEST_OK" : "MAC_SELF_TEST_FAIL") density=\(density) connected=\(connected) degraded=\(degraded) bindings=\(bindings) rows=\(rows) expected_rows=\(expectedRows) announcements=\(announcements)"
        writeReport(line, path: options.reportPath)
        return ok ? 0 : 1
    }

    private static func writeReport(_ line: String, path: String?) {
        print(line)
        guard let path, !path.isEmpty else { return }
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date())
        let payload = "[\(stamp)] \(line)\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(payload.utf8))
        } else {
            try? Data(payload.utf8).write(to: url, options: .atomic)
        }
    }
}
