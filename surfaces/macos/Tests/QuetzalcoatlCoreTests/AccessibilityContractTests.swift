import Foundation
import Testing
@testable import QuetzalcoatlCore

@Suite("无障碍契约")
struct AccessibilityContractTests {
    private var sourcesRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources")
    }

    private func allSwiftSources() throws -> [URL] {
        guard let enumerator = FileManager.default.enumerator(
            at: sourcesRoot,
            includingPropertiesForKeys: nil)
        else {
            return []
        }
        var files: [URL] = []
        for case let url as URL in enumerator where url.pathExtension == "swift" {
            files.append(url)
        }
        return files
    }

    @Test("契约结构完整")
    func catalogIsStructurallyComplete() {
        let issues = AccessibilityCatalog.validateStructure()
        #expect(issues.isEmpty, "契约结构问题: \(issues)")
        #expect(AccessibilityCatalog.all.count >= 20)
        #expect(AccessibilityCatalog.all.contains { $0.id == "companion.send" && $0.minTarget >= 64 })
    }

    @Test("每个契约控件都在 SwiftUI 源码中声明")
    func everyCatalogControlIsDeclaredInSwiftUISources() throws {
        let files = try allSwiftSources()
        #expect(!files.isEmpty, "未找到 SwiftUI 源码目录: \(sourcesRoot.path)")
        let source = try files.map { try String(contentsOf: $0, encoding: .utf8) }.joined(separator: "\n")

        for control in AccessibilityCatalog.all {
            #expect(
                source.contains(#".accessibilityIdentifier("\#(control.id)")"#),
                "\(control.id): SwiftUI 源码缺少 accessibilityIdentifier")
            #expect(
                source.contains(#""\#(control.label)""#),
                "\(control.id): 无障碍名称「\(control.label)」未出现在源码中")
        }

        let labels = source.components(separatedBy: ".accessibilityLabel(").count - 1
        let interactive = AccessibilityCatalog.all.filter(\.isInteractive).count
        #expect(labels >= interactive, "无障碍名称修饰符数量少于可交互控件数")
        #expect(source.components(separatedBy: ".accessibilityAddTraits(.updatesFrequently)").count - 1 >= 2)
    }

    @Test("源码里没有未登记的无障碍标识")
    func noUnknownAccessibilityIdentifiers() throws {
        let files = try allSwiftSources()
        let source = try files.map { try String(contentsOf: $0, encoding: .utf8) }.joined(separator: "\n")
        let regex = try NSRegularExpression(pattern: #"\.accessibilityIdentifier\("([^"]+)"\)"#)
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        let known = Set(AccessibilityCatalog.all.map(\.id))
        var unknown: [String] = []
        for match in regex.matches(in: source, range: range) {
            guard
                match.numberOfRanges == 2,
                let idRange = Range(match.range(at: 1), in: source)
            else { continue }
            let id = String(source[idRange])
            if !known.contains(id) {
                unknown.append(id)
            }
        }
        #expect(unknown.isEmpty, "源码出现未登记的 accessibilityIdentifier: \(unknown)")
    }

    @Test("陪伴态文案零术语")
    func companionCopyIsZeroJargon() {
        let issues = ZeroJargon.auditCompanionCopy()
        #expect(issues.isEmpty, "陪伴态文案出现技术词: \(issues)")
    }

    @Test("每种降级原因的文案都零术语")
    func degradedCopyStaysZeroJargonForEveryReason() {
        for reason in DegradedReason.allCases {
            let view = DegradedCopy.copy(for: reason, technical: "technical detail")
            let issues = ZeroJargon.audit([view.title, view.detail, view.hint])
            #expect(issues.isEmpty, "\(reason): \(issues)")
            #expect(!view.title.isEmpty)
            #expect(!view.detail.isEmpty)
            #expect(!view.hint.isEmpty)
        }
    }
}
