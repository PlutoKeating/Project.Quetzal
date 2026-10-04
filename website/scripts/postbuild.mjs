// 构建后处理：/404 → 404.html（Workers 静态资源的 not_found_handling）、按预渲染产物生成 sitemap.xml、
// 把 Linux 一键安装脚本（源码在 ../cli/install.sh）原样放到 /install，并用 _headers 声明为纯文本（curl -fsSL …/install | bash）。
import { copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
// Workers 静态资源的 _headers：没有扩展名的文件默认按二进制流返回，这里声明为纯文本；缓存 5 分钟，发新版很快生效
writeFileSync(join(client, "_headers"), "/install\n  Content-Type: text/plain; charset=utf-8\n  Cache-Control: public, max-age=300\n");

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
console.log(`postbuild：404.html 与 /install 就位，sitemap.xml 含 ${urls.length} 个地址`);
