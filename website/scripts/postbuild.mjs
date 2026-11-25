#!/usr/bin/env node
// 构建后处理：
//   1. 预渲染的 /404 复制为 404.html（Workers 静态资源的 not_found_handling）
//   2. 把 scripts/install.sh 与 scripts/install.ps1 再放一份到站点根（/install、/install.ps1）；
//      Worker 的 run_worker_first 会先接管这两个路径，静态副本只是边缘/直连兜底，内容同源同字节
//   3. _headers：全站安全响应头（CSP 的 script-src 在下面逐页用 <meta> 收紧到 sha256）
//   4. 每个 HTML 的 <head> 最前面插入按页计算的内联脚本 CSP（含每个内联脚本的 sha256），
//      并补 <link rel="canonical">；hreflang 由 app/root.tsx 在渲染时输出
//   5. 断言每页 CSP 覆盖了该页所有内联脚本（漏一个就会被浏览器拦掉，宁可构建失败）
//   6. sitemap.xml / robots.txt
//   5. sitemap.xml
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("../build/client", import.meta.url));
const origin = process.env.SITE_ORIGIN ?? "https://quetzal.plutokeating.beer";

const notFound = join(client, "404", "index.html");
if (!existsSync(notFound)) throw new Error(`postbuild: missing prerendered 404 at ${notFound}`);
copyFileSync(notFound, join(client, "404.html"));

for (const [name, source] of [
  ["install", "../../scripts/install.sh"],
  ["install.ps1", "../../scripts/install.ps1"],
]) {
  const from = fileURLToPath(new URL(source, import.meta.url));
  if (!existsSync(from)) throw new Error(`postbuild: missing ${from}`);
  copyFileSync(from, join(client, name));
}

const CF_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://api.github.com https://registry.npmjs.org",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  `Content-Security-Policy: ${CF_CSP}`,
  "Strict-Transport-Security: max-age=31536000; includeSubDomains",
  "X-Content-Type-Options: nosniff",
  "Referrer-Policy: strict-origin-when-cross-origin",
  "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
];

writeFileSync(
  join(client, "_headers"),
  [
    "/*",
    ...securityHeaders.map((h) => `  ${h}`),
    "/install",
    "  Content-Type: text/plain; charset=utf-8",
    "  Cache-Control: public, max-age=300",
    "/install.ps1",
    "  Content-Type: text/plain; charset=utf-8",
    "  Cache-Control: public, max-age=300",
    "",
  ].join("\n"),
);

const INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const sha = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

const pages = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".html")) pages.push(path);
  }
};
walk(client);

const urlFor = (file) => {
  const rel = relative(client, file).replace(/\\/g, "/");
  const noIndex = rel.replace(/index\.html$/, "").replace(/\.html$/, "");
  return `${origin}/${noIndex}`.replace(/\/+$/, "") + (noIndex === "" ? "/" : "");
};

const isErrorPage = (file) => file.endsWith("404.html") || file.includes("/404/") || file.includes("__spa-fallback");

let touched = 0;
for (const file of pages) {
  let html = readFileSync(file, "utf8");
  const hashes = new Set();
  for (const match of html.matchAll(INLINE)) hashes.add(sha(match[1] ?? ""));
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${[...hashes].join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://api.github.com https://registry.npmjs.org",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  html = html.replace(/<head>/i, `<head>${meta}`);
  if (!isErrorPage(file)) {
    html = html.replace(/<\/head>/i, `<link rel="canonical" href="${urlFor(file)}"></head>`);
  }
  // Anti-regression: the CSP must cover every inline script on this page (no missing hash).
  for (const match of html.matchAll(INLINE)) {
    if (!csp.includes(sha(match[1] ?? ""))) throw new Error(`postbuild: inline script on ${file} is outside the CSP`);
  }
  writeFileSync(file, html);
  touched += 1;
}

const urls = pages
  .filter((f) => !isErrorPage(f))
  .map(urlFor)
  .sort();
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map((u) => `  <url><loc>${u}</loc></url>`),
  "</urlset>",
  "",
].join("\n");
writeFileSync(join(client, "sitemap.xml"), sitemap);
writeFileSync(join(client, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);

console.log(`postbuild: ${touched} pages got a per-page CSP, ${urls.length} URLs in sitemap.xml`);
