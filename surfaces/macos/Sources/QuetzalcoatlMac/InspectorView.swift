import QuetzalcoatlCore
import SwiftUI

/// 检视态：良知锁定正文、工具、审计与运行技术细节（只在本页出现）。
struct InspectorView: View {
    let snapshot: DesktopSnapshot
    let pumpSummary: String

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 8) {
                Text("良知锁定正文（两层式稳态）")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                ScrollView {
                    Text(snapshot.conscienceBody)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("inspector.conscience")

                Text("审计事件")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                List(snapshot.auditRows) { row in
                    Text(row.summary)
                        .font(.system(.caption, design: .monospaced))
                }
                .accessibilityIdentifier("inspector.audit")
                .accessibilityLabel("审计事件列表")
            }
            .padding(20)

            VStack(alignment: .leading, spacing: 8) {
                Text("工具调用")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                List(snapshot.tools) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.summary).font(.system(.caption, design: .monospaced))
                        if let detail = row.detail {
                            Text(detail).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityIdentifier("inspector.tools")
                .accessibilityLabel("工具调用列表")

                Text("运行技术日志")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                List(Array(snapshot.technicalLog.enumerated()), id: \.offset) { _, line in
                    Text(line).font(.system(.caption, design: .monospaced))
                }
                .accessibilityIdentifier("inspector.technical")
                .accessibilityLabel("运行技术日志")

                Text(pumpSummary)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("inspector.pump")

                ForEach(snapshot.statusRows) { row in
                    Text(row.summary)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
            .frame(minWidth: 280)
        }
    }
}
