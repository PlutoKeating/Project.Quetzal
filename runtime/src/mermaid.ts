// Mermaid 图的兜底渲染（网关方法 mermaid.render）：桌面控制台没有可用的网页引擎（Windows 缺 WebView2、Linux 缺 WebKitGTK）时，
// 由运行基座把 Mermaid 源码画成 SVG，控制台用 flutter_svg 显示。用 beautiful-mermaid（MIT，零 DOM；布局用 elkjs，EPL-2.0 或 GPL-3.0+）。
//   flutter_svg 只认静态的 SVG：这里把输出整理成「颜色都是具体值、没有 <style> / @import / CSS 变量 / color-mix / <marker>」——
//   变量按主题算出具体颜色，箭头从 marker 改画成多边形，背景透明（控制台自己铺底色）。
import { renderMermaid } from "beautiful-mermaid";

const THEME = {
  light: { bg: "#ffffff", fg: "#27272a" },
  dark: { bg: "#18181b", fg: "#e4e4e7" },
};
const MAX_CODE = 20_000;

const hex = (c: string): [number, number, number] | undefined => {
  const m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].split("").map((x) => x + x).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const toHex = (rgb: number[]) => "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

/** 解析 CSS 颜色表达式：#hex、var(--x[, 备选])、color-mix(in srgb, A p%, B)。解析不了返回 undefined。 */
export function resolveColor(expr: string, vars: Record<string, string>, depth = 0): string | undefined {
  const e = expr.trim();
  if (depth > 20) return undefined;
  if (hex(e)) return toHex(hex(e)!);
  let m = e.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/);
  if (m) {
    const v = vars[m[1]];
    if (v !== undefined) { const r = resolveColor(v, vars, depth + 1); if (r) return r; }
    return m[2] !== undefined ? resolveColor(m[2], vars, depth + 1) : undefined;
  }
  m = e.match(/^color-mix\(\s*in\s+srgb\s*,\s*([\s\S]+)\)$/i);
  if (m) {
    const [a, b] = splitTop(m[1]);
    if (b === undefined) return undefined;
    const pa = a.match(/^([\s\S]+?)\s+([\d.]+)%$/), pb = b.match(/^([\s\S]+?)\s+([\d.]+)%$/);
    const ca = resolveColor(pa ? pa[1] : a, vars, depth + 1), cb = resolveColor(pb ? pb[1] : b, vars, depth + 1);
    if (!ca || !cb) return undefined;
    const wa = pa ? Number(pa[2]) / 100 : pb ? 1 - Number(pb[2]) / 100 : 0.5;
    const A = hex(ca)!, B = hex(cb)!;
    return toHex(A.map((x, i) => x * wa + B[i] * (1 - wa)));
  }
  if (/^(none|transparent)$/i.test(e)) return e;
  return undefined;
}
/** 按顶层逗号分成两段（括号里的逗号不算）。 */
function splitTop(s: string): [string, string | undefined] {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") d++; else if (s[i] === ")") d--;
    else if (s[i] === "," && d === 0) return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
  }
  return [s.trim(), undefined];
}

/** 箭头（替代 marker）：在终点 (x2, y2) 沿 (x1,y1)→(x2,y2) 方向画一个 8×5 的三角形，尖端落在终点。 */
function arrow(x1: number, y1: number, x2: number, y2: number, color: string): string {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const bx = x2 - ux * 8, by = y2 - uy * 8, px = -uy * 2.5, py = ux * 2.5;
  const f = (n: number) => Number(n.toFixed(2));
  return `<polygon points="${f(x2)},${f(y2)} ${f(bx + px)},${f(by + py)} ${f(bx - px)},${f(by - py)}" fill="${color}" stroke="${color}" stroke-width="0.75" stroke-linejoin="round"/>`;
}
const pointsOf = (tag: string): number[][] => {
  const p = tag.match(/\spoints="([^"]+)"/);
  if (p) return p[1].trim().split(/\s+/).map((xy) => xy.split(",").map(Number));
  const l = tag.match(/\sx1="([-\d.]+)"\s+y1="([-\d.]+)"\s+x2="([-\d.]+)"\s+y2="([-\d.]+)"/);
  if (l) return [[+l[1], +l[2]], [+l[3], +l[4]]];
  const d = tag.match(/\sd="([^"]+)"/);
  if (d) return [...d[1].matchAll(/[ML]\s*([-\d.]+)[ ,]([-\d.]+)/gi)].map((m) => [+m[1], +m[2]]);
  return [];
};

/** 把 beautiful-mermaid 的输出整理成静态 SVG（见文件头）。 */
export function staticSvg(svg: string, theme: { bg: string; fg: string }): string {
  const vars: Record<string, string> = { "--bg": theme.bg, "--fg": theme.fg };
  for (const m of svg.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) if (!(m[1] in vars)) vars[m[1]] = m[2].trim();
  const color = (expr: string) => resolveColor(expr, vars) ?? theme.fg;
  // 记下每个 marker 的颜色，再删掉 <defs> 里的 marker、<style> 与根上的 style
  const markerColor = new Map<string, string>();
  for (const m of svg.matchAll(/<marker\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/marker>/g)) markerColor.set(m[1], color(m[2].match(/fill="([^"]+)"/)?.[1] ?? "var(--fg)"));
  let out = svg.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<marker\b[\s\S]*?<\/marker>/g, "").replace(/<defs>\s*<\/defs>/g, "");
  out = out.replace(/(<svg\b[^>]*?)\sstyle="[^"]*"/, "$1");
  // 带 marker 的线：去掉 marker 属性，在后面补一个三角形
  out = out.replace(/<(polyline|line|path)\b[^>]*?\/>/g, (tag) => {
    const end = tag.match(/marker-end="url\(#([^)]+)\)"/), start = tag.match(/marker-start="url\(#([^)]+)\)"/);
    if (!end && !start) return tag;
    const pts = pointsOf(tag);
    let extra = "";
    if (pts.length >= 2) {
      if (end) { const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]]; extra += arrow(a[0], a[1], b[0], b[1], markerColor.get(end[1]) ?? theme.fg); }
      if (start) { const [a, b] = [pts[1], pts[0]]; extra += arrow(a[0], a[1], b[0], b[1], markerColor.get(start[1]) ?? theme.fg); }
    }
    return tag.replace(/\smarker-(end|start)="[^"]*"/g, "") + extra;
  });
  // 属性里的颜色表达式换成具体值
  out = out.replace(/\s(fill|stroke|stop-color|color)="([^"]*(?:var\(|color-mix\()[^"]*)"/g, (_m, k: string, v: string) => ` ${k}="${color(v)}"`);
  out = out.replace(/\sstyle="([^"]*)"/g, (_m, css: string) => {
    const kept = css.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const i = d.indexOf(":"); if (i < 0) return "";
      const k = d.slice(0, i).trim(), v = d.slice(i + 1).trim();
      if (k.startsWith("--")) return "";
      return /var\(|color-mix\(/.test(v) ? `${k}:${color(v)}` : `${k}:${v}`;
    }).filter(Boolean).join(";");
    return kept ? ` style="${kept}"` : "";
  });
  return out.replace(/<foreignObject[\s\S]*?<\/foreignObject>/g, "");
}

/** 渲染：源码 → 静态 SVG。不认识的图表类型或语法错误抛出带说明的错误（控制台退回显示源码）。 */
export async function renderMermaidSvg(code: string, dark = false): Promise<string> {
  const src = String(code ?? "");
  if (!src.trim()) throw new Error("没有图");
  if (src.length > MAX_CODE) throw new Error("图太大了");
  const theme = dark ? THEME.dark : THEME.light;
  const raw = await renderMermaid(src, { bg: theme.bg, fg: theme.fg, font: "sans-serif" } as never);
  return staticSvg(raw, theme);
}
