import { reactRouter } from "@react-router/dev/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const designSystem = fileURLToPath(new URL("../packages/design-system", import.meta.url));

// 纯静态站：所有页面在构建时预渲染；Worker 只接管 /dl/*、/api/*、/install*。
// 视觉语言只有一份：packages/design-system。样式、字体与光学脚本都在构建时从那里取，官网不另存副本。
export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@design": designSystem,
    },
  },
  server: { fs: { allow: [fileURLToPath(new URL(".", import.meta.url)), designSystem] } },
  build: { target: "es2022" },
});
