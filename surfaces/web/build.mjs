// 构建：一份脚本、一份样式、设计系统的字体与光学脚本。
// 视觉语言只有一份：样式、字体与光学脚本都在构建时取自 packages/design-system，这里不另存副本。
// 产出纯静态资源，无内联脚本、无内联样式、无远程依赖，由 quetzalcoatld 同源托管。
import { build } from "esbuild";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const design = resolve(here, "../../packages/design-system");
const dist = join(here, "dist");
const assets = join(dist, "assets");
const target = ["chrome120", "firefox121", "safari17"];

await rm(dist, { recursive: true, force: true });
await mkdir(join(assets, "fonts"), { recursive: true });

await build({
  absWorkingDir: here,
  entryPoints: { app: "src/main.ts" },
  outdir: assets,
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  splitting: false,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  target,
  logLevel: "info",
});

// 设计系统的唯一入口 styles.css 连同它引用的字体一起打包；字体保留原文件名。
await build({
  absWorkingDir: here,
  entryPoints: { styles: join(design, "styles.css") },
  outdir: assets,
  entryNames: "[name]",
  assetNames: "fonts/[name]",
  loader: { ".woff2": "file" },
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  target,
  logLevel: "info",
});

await copyFile(join(design, "scripts/optics.js"), join(assets, "optics.js"));

// 字体以 SIL OFL 1.1 分发：许可文本跟着字体走。
for (const name of await readdir(join(design, "fonts"))) {
  if (name.startsWith("LICENSE")) {
    await copyFile(join(design, "fonts", name), join(assets, "fonts", name));
  }
}

await copyFile(join(here, "index.html"), join(dist, "index.html"));

console.log("surfaces/web/dist 已生成（index.html + assets/{app.js,styles.css,optics.js,fonts/*}）");
