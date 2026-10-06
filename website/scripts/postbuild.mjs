// 构建后处理：/404 → 404.html（Workers 静态资源的 not_found_handling）、按预渲染产物生成 sitemap.xml、
// 把 Linux 一键安装脚本（源码在 ../cli/install.sh）原样放到 /install，并用 _headers 声明为纯文本（curl -fsSL …/install | bash）；
// 给每个预渲染页面写入按页计算的脚本 CSP（<meta>），_headers 给全站加安全响应头（见 docs/ARCHITECTURE.md §1.1）。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("../build/client", import.meta.url));
const origin = process.env.SITE_ORIGIN ?? "https://quetzal.plutokeating.beer";

const notFound = join(client, "404", "index.html");
if (existsSync(notFound)) copyFileSync(notFound, join(client, "404.html"));

// /install：一键安装脚本。源码只有一份（cli/install.sh），这里不改内容，只复制；缺了就让构建失败，免得官网上挂着 404。
const installer = fileURLToPath(new URL("../../cli/install.sh", import.meta.url));
if (!existsSync(installer)) throw new Error(`postbuild：找不到 ${installer}（一键安装脚本的源码）`);
copyFileSync(installer, join(client, "install"));
copyFileSync(fileURLToPath(new URL("../../cli/install.ps1", import.meta.url)), join(client, "install.ps1")); // Windows：irm …/install.ps1 | iex（纯 ASCII，由 cli/windows/install.src.ps1 生成）

// 安全响应头（Workers 静态资源的 _headers；/dl/* 与 /api/* 由 Worker 响应，不经过这里）。
// 内联脚本（主题、语言跳转、/device 转发、React Router 的上下文与水合入口）每页不同，而 _headers 规则最多 100 条、每行最多 2000 字符，
// 装不下逐页的哈希。所以分两层（两条 CSP 同时生效，浏览器取交集）：
//   响应头：除脚本外的全部限制，script-src 放宽到 'self' 'unsafe-inline'；
//   每个 HTML 的 <meta http-equiv="Content-Security-Policy">：script-src 只放 'self' 与该页每个内联脚本的 sha256（放在 <head> 最前，先于任何脚本）。
// 'wasm-unsafe-eval' 给站内搜索 pagefind（WebAssembly）；style-src 的 'unsafe-inline' 给 React 的 style 属性、KaTeX 与 mermaid 生成的样式；font-src 的 data: 给 KaTeX 样式表里内嵌的字体。
// Cloudflare 网页分析（Web Analytics）由边缘自动注入的统计脚本：放行它的脚本源与上报地址，否则每页都有两条 CSP 违规（不影响功能）
const CF_BEACON = "https://static.cloudflareinsights.com";
const SYNC = "https://sync.quetzal.plutokeating.beer";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${CF_BEACON}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${SYNC} https://api.github.com https://registry.npmjs.org https://cloudflareinsights.com`, // registry.npmjs.org：直连 GitHub 的退路按 npm 的版本封顶
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  `form-action 'self' ${SYNC}`,
].join("; ");
const security = [
  `Content-Security-Policy: ${csp}`,
  "X-Content-Type-Options: nosniff",
  "Referrer-Policy: strict-origin-when-cross-origin",
  "Strict-Transport-Security: max-age=31536000; includeSubDomains",
  "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
];
// /install：没有扩展名的文件默认按二进制流返回，这里声明为纯文本；缓存 5 分钟，发新版很快生效
writeFileSync(join(client, "_headers"), [
  "/*", ...security.map((h) => `  ${h}`),
  "/install", "  Content-Type: text/plain; charset=utf-8", "  Cache-Control: public, max-age=300",
  "/install.ps1", "  Content-Type: text/plain; charset=utf-8", "  Cache-Control: public, max-age=300", "",
].join("\n"));

const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
let pages = 0;
const withCsp = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { withCsp(p); continue; }
    if (!name.endsWith(".html")) continue;
    const html = readFileSync(p, "utf8");
    if (html.includes('http-equiv="Content-Security-Policy"')) continue;
    const hashes = [...new Set([...html.matchAll(INLINE)].map((m) => sha(m[1])))];
    const meta = `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'wasm-unsafe-eval' ${CF_BEACON} ${hashes.join(" ")}"/>`;
    // 紧跟在 <meta charSet> 之后（没有就紧跟 <head>），必须先于第一个脚本
    const anchor = html.includes('<meta charSet="utf-8"/>') ? '<meta charSet="utf-8"/>' : "<head>";
    const at = html.indexOf(anchor) + anchor.length;
    if (at < anchor.length || html.indexOf("<script") < at) throw new Error(`postbuild：${p} 没有 <head> 或脚本在 CSP 位置之前，无法写入`);
    writeFileSync(p, html.slice(0, at) + meta + html.slice(at));
    pages++;
  }
};
withCsp(client);

const urls = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name === "index.html") {
      const rel = relative(client, dir).replaceAll("\\", "/");
      if (rel === "404") continue;
      urls.push(rel ? `${origin}/${rel}` : `${origin}/`);
    }
  }
};
walk(client);
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.w3.org/1999/xhtml">\n${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}\n</urlset>\n`;
writeFileSync(join(client, "sitemap.xml"), xml.replace('xmlns="http://www.w3.org/1999/xhtml"', 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'));
console.log(`postbuild：404.html 与 /install 就位，${pages} 个页面写入脚本 CSP，sitemap.xml 含 ${urls.length} 个地址`);
