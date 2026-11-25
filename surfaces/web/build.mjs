// 构建：esbuild 打包两个 ES 模块入口（应用 / WASM 缓存 Worker）与一份 CSS。
// 产出纯静态资源，无内联脚本、无 eval、无远程依赖，可直接由 quetzalcoatld 同源托管。
import { build } from "esbuild";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await mkdir("dist/assets", { recursive: true });

await build({
  entryPoints: {
    app: "src/main.ts",
    wasm_cache_worker: "src/worker/wasm_cache_worker.ts",
    styles: "src/styles/app.css",
  },
  outdir: "dist/assets",
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  splitting: false,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  target: ["chrome120", "firefox121", "safari17"],
  logLevel: "info",
});

await copyFile("index.html", "dist/index.html");

try {
  await cp("public", "dist", { recursive: true });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

// WASM 缓存宿主是可选资产：默认构建刻意排除，保证 `no-wasm` 降级路径可确定性测试。
// 需要时先运行 scripts/build-web-wasm.sh，再以 QZ_WEB_WITH_WASM=1 构建。
if (process.env.QZ_WEB_WITH_WASM !== "1") {
  await rm("dist/wasm", { recursive: true, force: true });
}

console.log("surfaces/web/dist 已生成（index.html + assets/{app.js,styles.css,wasm_cache_worker.js}）");
