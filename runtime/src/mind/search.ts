// 网页搜索：抓取搜索引擎的结果页并解析成「标题 / 真实链接 / 摘要」。
//   必须带真实浏览器的请求头：只写 "Mozilla/5.0" 时必应返回的是不含结果的页面。
//   实测（2026-09）：必应对程序请求的多词查询会「降级」，只按第一个词给结果（带 Cookie 也一样）；360 搜索的相关性最好。
//   各家都有反爬：短时间请求多了会出验证码页。所以每个引擎的结果都要检查——
//     · 验证码页：报告「要求验证码」，换下一个；
//     · 相关性：结果的标题与摘要覆盖了多少查询关键词（中文按二字组），覆盖不足视为不相关，换下一个；
//   都不理想时，返回最相关的那一组并注明。顺序：中文 360 → 百度 → 必应；英文为主 360 → 必应国际版 → 百度。
//   必应的结果链接可能是跳转链接（bing.com/ck/a?…&u=a1<base64url>），解码成真实地址；百度优先取结果块上的 mu（真实地址）。
import { decode } from "./documents.ts";
import { tokens } from "../memory/retrieval.ts";

export interface SearchResult { title: string; url: string; snippet: string }

export const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** 结果里的 HTML → 纯文本：行内标签（strong、em、span…）直接去掉，块级标签换成空格。 */
const clean = (html: string) => decode(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?(br|p|div|li|h\d|tr|td|section)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, ""))
  .replace(/[\ue000-\uf8ff]/g, "").replace(/\s+/g, " ").trim(); // 去掉图标字体（私用区字符）

/** 必应的跳转链接 → 真实地址。 */
export function bingTarget(href: string): string {
  const url = decode(href);
  if (!/bing\.com\/ck\/a/.test(url)) return url;
  const u = new URL(url, "https://www.bing.com").searchParams.get("u");
  if (!u?.startsWith("a1")) return url;
  try { return Buffer.from(u.slice(2).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return url; }
}

export function parseBing(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const part of html.split(/<li class="b_algo"/).slice(1)) {
    const block = part.split(/<\/li>\s*(?=<li|<\/ol)/)[0].replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
    const a = block.match(/<h2[^>]*>\s*<a\b[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const p = block.match(/<div class="b_caption[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/) ?? block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: clean(a[2]), url: bingTarget(a[1]), snippet: clean(p?.[1] ?? "") });
  }
  return out.filter((r) => r.title && /^https?:/.test(r.url));
}

export function parseSo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const part of html.split(/<li class="res-list/).slice(1)) {
    const block = part.split(/<\/li>/)[0].replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
    const a = block.match(/<h3 class="res-title[^"]*"[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decode(a[1].match(/data-mdurl="([^"]+)"/)?.[1] ?? a[1].match(/\bhref="([^"]+)"/)?.[1] ?? "");
    const s = block.match(/<span class="res-list-summary"[^>]*>([\s\S]*?)<\/span>/) ?? block.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: clean(a[2]), url, snippet: clean(s?.[1] ?? "") });
  }
  return out.filter((r) => r.title && /^https?:/.test(r.url));
}

export function parseBaidu(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const part of html.split(/<div class="result(?:-op)? c-container/).slice(1)) {
    const block = part.replace(/<(script|style)[\s\S]*?<\/\1>/g, "");
    const h3 = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const title = clean(h3[1]);
    const mu = block.match(/^[^>]*\bmu="([^"]+)"/)?.[1];
    const href = h3[1].match(/href="([^"]+)"/)?.[1];
    const url = decode(mu && /^https?:/.test(decode(mu)) ? mu : href ?? "");
    const rest = clean(block.slice(block.indexOf("</h3>") + 5)).replace(title, "").trim();
    out.push({ title, url, snippet: rest.slice(0, 200) });
  }
  return out.filter((r) => r.title && /^https?:/.test(r.url));
}

const ENGINES = {
  so: { name: "360 搜索", url: (q: string) => `https://www.so.com/s?q=${encodeURIComponent(q)}`, parse: parseSo },
  "bing-intl": { name: "必应国际版", url: (q: string) => `https://cn.bing.com/search?ensearch=1&q=${encodeURIComponent(q)}`, parse: parseBing },
  "bing-cn": { name: "必应", url: (q: string) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
  baidu: { name: "百度", url: (q: string) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaidu },
} as const;
export type Engine = keyof typeof ENGINES;

/** 缺省的引擎顺序（固定，不按查询的文字猜语言）：360 搜索、百度、必应。英文资料她可以指定必应国际版（engine: bing-intl）。 */
export const ORDER: Engine[] = ["so", "baidu", "bing-cn"];

/** 搜索：依次尝试引擎，返回可读的结果列表。 */
export async function webSearch(query: string, o: { count?: number; engine?: Engine; fetcher?: typeof fetch } = {}): Promise<string> {
  const count = Math.min(10, Math.max(1, Math.floor(o.count ?? 8)));
  const f = o.fetcher ?? fetch;
  const tried: string[] = [];
  const show = (name: string, results: SearchResult[]) =>
    `【${name}】「${query}」前 ${results.length} 条（需要全文用 web_fetch 打开链接）：\n` +
    results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n");
  // 拿到结果即止：结果相不相关由她自己看（不按关键词重叠去猜，猜错会丢掉有用的结果）
  for (const id of o.engine ? [o.engine] : ORDER) {
    const e = ENGINES[id];
    try {
      const res = await f(e.url(query), { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) { tried.push(`${e.name}（HTTP ${res.status}）`); continue; }
      const results = e.parse(await res.text()).slice(0, count);
      if (results.length) return show(e.name, results);
      // 没有结果：被转到了别的网站（例如验证页）就照实写出转到了哪里
      const asked = new URL(e.url(query)).hostname, landed = res.url ? new URL(res.url).hostname : asked;
      tried.push(`${e.name}（${landed !== asked ? `没有结果，被转到了 ${landed}` : "没有结果"}）`);
    } catch (err: any) {
      tried.push(`${e.name}（${err?.name === "TimeoutError" ? "超时" : err?.message ?? err}）`);
    }
  }
  return `没有找到结果。已尝试：${tried.join("、")}。可以换个说法或关键词再试。`;
}
