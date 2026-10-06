// 把 sandbox-runtime（Windows 命令沙箱，Apache-2.0）打包成单独的 ESM 文件 dist/srt.mjs：它用 import.meta.url，不能并进 CJS 的 main.cjs。
// 运行基座只在 Windows 上加载它（src/sandbox.ts）；srt-win.exe 由打包 Windows 发布的步骤从 node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/<架构>/ 取。
import { build } from "esbuild";
await build({
  entryPoints: ["node_modules/@anthropic-ai/sandbox-runtime/dist/index.js"],
  bundle: true, platform: "node", target: "node22", format: "esm", outfile: "dist/srt.mjs", logLevel: "warning",
  // 打包进来的 CommonJS 依赖（commander、node-forge）要用 require 加载 Node 内置模块
  banner: { js: "import { createRequire as __qCreateRequire } from 'node:module'; const require = __qCreateRequire(import.meta.url);" },
});
