import Foundation

/// 零术语守卫：陪伴态面向长辈，任何 IPC/套接字/事件序号等技术词都不允许出现。
public enum ZeroJargon {
    public static let forbiddenTerms: [String] = [
        "IPC", "socket", "pid", "SQLite", "JSON", "token", "WAL", "RPC",
        "endpoint", "spine", "HTTP", "gRPC", "WebSocket", "schema", "rev=",
        "错误码", "脊柱", "事件序号",
    ]

    /// 返回文本中命中的技术词（空集合表示零术语通过）。
    public static func find(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        return forbiddenTerms.filter { term in
            text.range(of: term, options: [.caseInsensitive]) != nil
        }
    }

    /// 批量审计；返回「文案 → 命中词」的明细。
    public static func audit(_ texts: [String]) -> [String] {
        texts.compactMap { text in
            let hits = find(text)
            guard !hits.isEmpty else { return nil }
            return "「\(text)」包含技术词: \(hits.joined(separator: ", "))"
        }
    }

    /// 陪伴态全部文案是否零术语。
    public static func auditCompanionCopy() -> [String] {
        audit(CompanionCopy.all)
    }
}
