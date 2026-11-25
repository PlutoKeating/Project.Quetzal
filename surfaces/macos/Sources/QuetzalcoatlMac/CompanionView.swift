import QuetzalcoatlCore
import SwiftUI

/// 陪伴态：零术语、≥64pt 触点、流式对话正文。
struct CompanionView: View {
    let snapshot: DesktopSnapshot
    let onSend: (String) -> Void
    let onRetry: () -> Void

    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(snapshot.heading)
                .font(.system(size: 34, weight: .semibold))
                .accessibilityIdentifier("companion.heading")
                .accessibilityAddTraits(.isHeader)

            ScrollView {
                Text(snapshot.transcript)
                    .font(.system(size: 22))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("companion.transcript")
            .accessibilityHint(CompanionCopy.transcriptHint)
            .accessibilityAddTraits(.updatesFrequently)

            if snapshot.showHint {
                Text(snapshot.hintText)
                    .font(.system(size: 18))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("companion.hint")
            }

            HStack(spacing: 12) {
                TextField(CompanionCopy.entryPlaceholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 20))
                    .frame(minHeight: 64)
                    .disabled(!snapshot.isInputEnabled)
                    .onSubmit(send)
                    .accessibilityIdentifier("companion.entry")
                    .accessibilityLabel(CompanionCopy.entryLabel)
                    .accessibilityHint(CompanionCopy.entryHint)

                Button(CompanionCopy.sendLabel, action: send)
                    .buttonStyle(.borderedProminent)
                    .font(.system(size: 20))
                    .frame(minWidth: 160, minHeight: 72)
                    .disabled(!snapshot.isInputEnabled)
                    .accessibilityIdentifier("companion.send")
                    .accessibilityLabel("发送这句话")
            }

            if snapshot.showRetry {
                Button(CompanionCopy.retryLabel, action: onRetry)
                    .buttonStyle(.bordered)
                    .font(.system(size: 18))
                    .frame(minHeight: 72)
                    .accessibilityIdentifier("companion.retry")
                    .accessibilityLabel("重新连接本机助手")
            }

            HStack(spacing: 8) {
                Text(snapshot.statusText)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("companion.status")
                if snapshot.isStreaming {
                    ProgressView()
                        .controlSize(.small)
                    Text(snapshot.streamingIndicator)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("companion.streaming")
                }
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        onSend(text)
    }
}
