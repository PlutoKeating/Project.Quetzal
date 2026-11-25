import QuetzalcoatlCore
import SwiftUI

/// 工作台态：会话、工作流、审批与消息输入。
struct WorkbenchView: View {
    let snapshot: DesktopSnapshot
    let onSend: (String) -> Void
    let onApprove: (String, Bool) -> Void

    @State private var draft = ""

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 10) {
                Text("当前对话")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)

                ScrollView {
                    Text(snapshot.transcript)
                        .font(.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("workbench.transcript")

                ForEach(Array(snapshot.notices.enumerated()), id: \.offset) { _, notice in
                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 10) {
                    TextField("继续说明，或粘贴要处理的材料", text: $draft, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .frame(minHeight: 40)
                        .onSubmit(send)
                        .accessibilityIdentifier("workbench.entry")
                        .accessibilityLabel("工作台输入框")

                    Button("发送", action: send)
                        .buttonStyle(.borderedProminent)
                        .frame(minWidth: 96, minHeight: 40)
                        .accessibilityIdentifier("workbench.send")
                        .accessibilityLabel("工作台发送按钮")
                }
            }
            .padding(20)

            VStack(alignment: .leading, spacing: 16) {
                Text("运行中的工作流")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)

                List(snapshot.workflows) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.summary).font(.callout)
                        if let detail = row.detail {
                            Text(detail).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityIdentifier("workbench.workflows")
                .accessibilityLabel("工作流列表")

                Text("等待你确认的操作")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)

                List(snapshot.approvals) { row in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(row.summary).font(.callout)
                        HStack(spacing: 8) {
                            Button("批准") { onApprove(row.key, true) }
                                .accessibilityIdentifier("workbench.approve/\(row.key)")
                                .accessibilityLabel("批准这项操作（\(row.summary)）")
                            Button("拒绝") { onApprove(row.key, false) }
                                .accessibilityIdentifier("workbench.deny/\(row.key)")
                                .accessibilityLabel("拒绝这项操作（\(row.summary)）")
                        }
                    }
                }
                .accessibilityIdentifier("workbench.approvals")
                .accessibilityLabel("待批准操作列表")
            }
            .padding(20)
            .frame(minWidth: 280)
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        onSend(text)
    }
}
