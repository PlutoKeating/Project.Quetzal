namespace Quetzalcoatl.Desktop.A11y;

/// <summary>
/// 零术语守卫：陪伴态面向长辈，任何 IPC/套接字/事件序号等技术词都不允许出现。
/// 文案集中放在 <see cref="ViewModels.CompanionCopy"/>，本守卫对全部文案做静态审计。
/// </summary>
public static class ZeroJargon
{
    private static readonly string[] ForbiddenTerms =
    [
        "IPC",
        "socket",
        "pid",
        "SQLite",
        "JSON",
        "token",
        "WAL",
        "RPC",
        "endpoint",
        "spine",
        "HTTP",
        "gRPC",
        "WebSocket",
        "schema",
        "rev=",
        "错误码",
        "脊柱",
        "事件序号",
    ];

    /// <summary>返回文本中命中的技术词（空集合表示零术语通过）。</summary>
    public static IReadOnlyList<string> Find(string text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return [];
        }

        var hits = new List<string>();
        foreach (var term in ForbiddenTerms)
        {
            if (text.Contains(term, StringComparison.OrdinalIgnoreCase))
            {
                hits.Add(term);
            }
        }

        return hits;
    }

    /// <summary>批量审计；返回「文案 → 命中词」的明细。</summary>
    public static IReadOnlyList<string> Audit(IEnumerable<string> texts)
    {
        ArgumentNullException.ThrowIfNull(texts);
        var issues = new List<string>();
        foreach (var text in texts)
        {
            var hits = Find(text);
            if (hits.Count > 0)
            {
                issues.Add($"「{text}」包含技术词: {string.Join(", ", hits)}");
            }
        }

        return issues;
    }

    /// <summary>陪伴态全部文案是否零术语。</summary>
    public static IReadOnlyList<string> AuditCompanionCopy() => Audit(Quetzalcoatl.Desktop.ViewModels.CompanionCopy.All);
}
