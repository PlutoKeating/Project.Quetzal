import AppKit
import Foundation
import QuetzalcoatlCore
import QuetzalcoatlInterop

/// 把播报出口接到 AppKit 无障碍通道（等价 `aria-live` + 显式 announcement 请求）。
@MainActor
final class SystemAnnouncementSink: AnnouncementSink {
    weak var window: NSWindow?

    func announce(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let element: Any = window ?? NSApp as Any
        NSAccessibility.post(
            element: element,
            notification: .announcementRequested,
            userInfo: [
                .announcement: text,
                .priority: NSAccessibilityPriorityLevel.medium.rawValue,
            ])
    }
}

/// 应用级协调器：探测本机守护进程、构建视图模型、接线流泵与偏好。
@MainActor
final class AppCoordinator: ObservableObject {
    let viewModel: DesktopViewModel
    let home: HomePaths
    let options: LaunchOptions
    private(set) var preferences: DesktopPreferences

    private let store: PreferencesStore
    private let sink: SystemAnnouncementSink
    private var pump: StreamPump?

    init(options: LaunchOptions) {
        self.options = options
        self.home = HomePaths.resolve(explicit: options.home)
        self.store = PreferencesStore(path: HomePaths.resolve(explicit: options.home).preferencesPath)
        self.preferences = store.load()
        self.sink = SystemAnnouncementSink()

        let probe = LocalDaemonProbe.probe(
            home: HomePaths.resolve(explicit: options.home),
            bindingsAvailable: StreamSourceFactory.bindingsAvailable)
        var model = UiModel.fromConnection(probe.connection, density: preferences.density)
        model.technical(probe.technical)
        if options.demoRows {
            try? DemoData.apply(to: &model)
        }

        let viewModel = DesktopViewModel(model: model, sink: sink)
        if !probe.bindingsAvailable {
            viewModel.notice(CompanionCopy.bindingsUnavailableNotice)
        }
        self.viewModel = viewModel

        if options.demoStream > 0, probe.connection.isOnline,
           let source = StreamSourceFactory.open(eventCount: options.demoStream) {
            let pump = viewModel.makePump(source: source)
            pump.start()
            self.pump = pump
        }
    }

    /// 把主窗口交给播报器（VoiceOver 通知需要一个元素锚点）。
    func attach(window: NSWindow?) {
        sink.window = window
    }

    /// 切换密度并持久化。
    func setDensity(_ density: CognitionDensity) {
        viewModel.applyDensity(density)
        preferences.density = density
        try? store.save(preferences)
    }

    /// 重新探测本机助手。
    func retry() {
        let probe = LocalDaemonProbe.probe(
            home: home,
            bindingsAvailable: StreamSourceFactory.bindingsAvailable)
        viewModel.setConnection(probe.connection)
        viewModel.technical(probe.technical)
        viewModel.notice(probe.connection.isOnline
            ? "已重新连接本机助手。"
            : "还是连不上本机助手，请确认它正在运行。")
        if !probe.bindingsAvailable {
            viewModel.notice(CompanionCopy.bindingsUnavailableNotice)
        }
    }

    /// 退出前收束流泵并写盘。
    func shutdown() {
        pump?.stop()
        pump = nil
        preferences.density = viewModel.density
        try? store.save(preferences)
    }
}
