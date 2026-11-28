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
/// 取值来自 Quetzalcoatl 设计系统（packages/design-system/tokens）：纯黑底、白字，唯一的实色是白色主按钮。
struct GovernanceShellView: View {
    @State private var status = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Quetzalcoatl")
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(Palette.ink)
            Text("治理面在 Web 与 Linux 上；在终端运行 qz open。")
                .foregroundStyle(Palette.secondary)
            Button("打开本机治理面") {
                status = QzOpen.run()
                    ? "已请求打开本机治理面。"
                    : "没有找到 qz 命令；请在终端运行 qz open。"
            }
            .buttonStyle(WhiteButtonStyle())
            .accessibilityIdentifier("open-governance")
            if !status.isEmpty {
                Text(status)
                    .foregroundStyle(Palette.subtle)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Palette.void)
        .preferredColorScheme(.dark)
    }
}

/// 设计系统的颜色（tokens/colors.css）。
enum Palette {
    static let void = Color(red: 0, green: 0, blue: 0)
    static let ink = Color(red: 1, green: 1, blue: 1)
    static let secondary = Color(red: 0x8a / 255, green: 0x8a / 255, blue: 0x8a / 255)
    static let subtle = Color(red: 0xa3 / 255, green: 0xa3 / 255, blue: 0xa3 / 255)
}

/// `.qz-btn-white`：白底黑字、圆角 5、没有阴影；按下时只改透明度。
struct WhiteButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Palette.void)
            .padding(.vertical, 9)
            .padding(.horizontal, 18)
            .background(RoundedRectangle(cornerRadius: 5).fill(Palette.ink))
            .opacity(configuration.isPressed ? 0.88 : 1)
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
