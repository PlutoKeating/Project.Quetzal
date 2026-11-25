import AppKit
import QuetzalcoatlCore
import SwiftUI

@main
struct QuetzalcoatlMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var coordinator: AppCoordinator

    init() {
        let options = LaunchOptions.parse(CommandLine.arguments)
        if options.printLaunchAgent {
            let executable = Bundle.main.executablePath ?? CommandLine.arguments[0]
            print(LaunchdSupport.agentPlist(executablePath: executable, home: options.home))
            exit(0)
        }
        if options.selfTest {
            exit(SelfTest.run(options: options))
        }
        _coordinator = StateObject(wrappedValue: AppCoordinator(options: options))
    }

    var body: some Scene {
        WindowGroup("Quetzalcoatl", id: "main") {
            MainView(viewModel: coordinator.viewModel)
                .environmentObject(coordinator)
                .frame(minWidth: 720, minHeight: 520)
                .background(WindowAccessor { window in
                    coordinator.attach(window: window)
                })
        }
        .defaultSize(width: coordinator.preferences.width, height: coordinator.preferences.height)
        .commands {
            CommandMenu("视图密度") {
                Button("陪伴") { coordinator.setDensity(.companion) }
                    .keyboardShortcut("1", modifiers: .command)
                Button("工作台") { coordinator.setDensity(.workbench) }
                    .keyboardShortcut("2", modifiers: .command)
                Button("检视") { coordinator.setDensity(.inspector) }
                    .keyboardShortcut("3", modifiers: .command)
            }
        }

        MenuBarExtra {
            MenuBarMenu()
                .environmentObject(coordinator)
        } label: {
            Label("Quetzalcoatl", systemImage: "circle.hexagongrid")
        }
    }
}

/// 应用代理：关闭窗口不退出（菜单栏常驻），退出前由协调器写盘。
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--menu-bar-only") {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}

/// 菜单栏菜单：显示主窗口 / 退出。
struct MenuBarMenu: View {
    @EnvironmentObject private var coordinator: AppCoordinator
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("显示主窗口") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        .accessibilityIdentifier("menu.show")
        .accessibilityLabel("显示 Quetzalcoatl 主窗口")

        Divider()

        Button("退出 Quetzalcoatl") {
            coordinator.shutdown()
            NSApp.terminate(nil)
        }
        .accessibilityIdentifier("menu.quit")
        .accessibilityLabel("退出 Quetzalcoatl")
    }
}

/// 从 SwiftUI 视图拿到宿主 NSWindow（播报锚点只有一次赋值）。
struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            onWindow(view.window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            onWindow(nsView.window)
        }
    }
}
