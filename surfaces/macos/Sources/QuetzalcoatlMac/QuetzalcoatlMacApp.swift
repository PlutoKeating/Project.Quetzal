import Foundation
import SwiftUI

@main
struct QuetzalcoatlMacApp: App {
    var body: some Scene {
        WindowGroup("Quetzalcoatl") {
            GovernanceShellView()
                .frame(minWidth: 420, minHeight: 240)
        }
        .windowResizability(.contentSize)
    }
}

/// 最小治理外壳：说明治理面在哪里，并提供一个打开本机治理面的按钮。
struct GovernanceShellView: View {
    @State private var status = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Quetzalcoatl")
                .font(.title)
            Text("治理面在 Web 与 Linux 上；在终端运行 qz open。")
            Button("打开本机治理面") {
                status = QzOpen.run()
                    ? "已请求打开本机治理面。"
                    : "没有找到 qz 命令；请在终端运行 qz open。"
            }
            .accessibilityIdentifier("open-governance")
            if !status.isEmpty {
                Text(status)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(32)
    }
}

/// 通过 `PATH` 里的 `qz open` 打开本机治理面；找不到或启动失败返回 `false`。
enum QzOpen {
    static func run() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["qz", "open"]
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }
}
