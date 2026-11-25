import AppKit
import Combine
import QuetzalcoatlCore
import SwiftUI

/// 主界面：密度切换条 + 三档视图 + 状态栏 + 应用级实时播报区域。
struct MainView: View {
    @ObservedObject var viewModel: DesktopViewModel
    @EnvironmentObject private var coordinator: AppCoordinator

    var body: some View {
        VStack(spacing: 0) {
            DensitySwitcher(
                density: viewModel.snapshot.density,
                onSelect: { coordinator.setDensity($0) })
                .padding(.horizontal, 20)
                .padding(.vertical, 10)

            Divider()

            Group {
                switch viewModel.snapshot.density {
                case .companion:
                    CompanionView(
                        snapshot: viewModel.snapshot,
                        onSend: { viewModel.pushUserMessage($0) },
                        onRetry: { coordinator.retry() })
                case .workbench:
                    WorkbenchView(
                        snapshot: viewModel.snapshot,
                        onSend: { viewModel.pushUserMessage($0) },
                        onApprove: { key, approved in
                            viewModel.notice(
                                (approved ? "已记下「批准」：" : "已记下「拒绝」：")
                                    + key
                                    + "。等本机助手接通后才会真正生效。")
                        })
                case .inspector:
                    InspectorView(snapshot: viewModel.snapshot, pumpSummary: viewModel.pumpSummary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()
            StatusBar(snapshot: viewModel.snapshot)
                .padding(.horizontal, 20)
                .padding(.vertical, 6)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .topLeading) {
            // 应用级实时播报区域：1×1 透明文本，每批流事件只改一次。
            Text(viewModel.lastAnnouncement)
                .frame(width: 1, height: 1)
                .opacity(0)
                .accessibilityIdentifier("live.announcement")
                .accessibilityLabel("实时播报区域")
                .accessibilityAddTraits(.updatesFrequently)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("shell.root")
        .accessibilityLabel("Quetzalcoatl 桌面")
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            coordinator.shutdown()
        }
    }
}

/// 三档认知密度切换（原生按钮，具备选中态与 ⌘1/2/3 快捷键）。
struct DensitySwitcher: View {
    let density: CognitionDensity
    let onSelect: (CognitionDensity) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button("陪伴") { onSelect(.companion) }
                .buttonStyle(.bordered)
                .frame(minWidth: 96, minHeight: 32)
                .tint(density == .companion ? .accentColor : .secondary)
                .accessibilityIdentifier("tab.companion")
                .accessibilityLabel("陪伴视图（⌘1）")
                .accessibilityAddTraits(density == .companion ? .isSelected : [])

            Button("工作台") { onSelect(.workbench) }
                .buttonStyle(.bordered)
                .frame(minWidth: 96, minHeight: 32)
                .tint(density == .workbench ? .accentColor : .secondary)
                .accessibilityIdentifier("tab.workbench")
                .accessibilityLabel("工作台视图（⌘2）")
                .accessibilityAddTraits(density == .workbench ? .isSelected : [])

            Button("检视") { onSelect(.inspector) }
                .buttonStyle(.bordered)
                .frame(minWidth: 96, minHeight: 32)
                .tint(density == .inspector ? .accentColor : .secondary)
                .accessibilityIdentifier("tab.inspector")
                .accessibilityLabel("检视视图（⌘3）")
                .accessibilityAddTraits(density == .inspector ? .isSelected : [])

            Spacer()

            Text("Quetzalcoatl")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("nav.density")
        .accessibilityLabel("视图密度")
    }
}

/// 底部状态栏（持续更新的实时区域）。
struct StatusBar: View {
    let snapshot: DesktopSnapshot

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: snapshot.isOnline ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(snapshot.isOnline ? Color.green : Color.orange)
                .accessibilityHidden(true)
            Text(snapshot.statusText)
                .font(.callout)
                .accessibilityIdentifier("status.connection")
                .accessibilityLabel("连接状态提示")
                .accessibilityValue(snapshot.statusText)
                .accessibilityAddTraits(.updatesFrequently)
            Spacer()
            if snapshot.showHint {
                Text(snapshot.degradedDetail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .accessibilityHidden(true)
            }
        }
    }
}
