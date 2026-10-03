// 构建后处理：/404 → 404.html（Workers 静态资源的 not_found_handling），并按预渲染产物生成 sitemap.xml。
import { copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("../build/client", import.meta.url));
const origin = process.env.SITE_ORIGIN ?? "https://windler.plutokeating.beer";

const notFound = join(client, "404", "index.html");
if (existsSync(notFound)) copyFileSync(notFound, join(client, "404.html"));

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
console.log(`postbuild：404.html 就位，sitemap.xml 含 ${urls.length} 个地址`);
