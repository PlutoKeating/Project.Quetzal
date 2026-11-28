import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 单测不起 react-router 插件（它会把 app/ 当路由树编译）：Worker 与共享逻辑是纯 TS，
// 页面不变量用 react-dom/server 把每个页面渲染成静态 HTML 再检查。
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@design": fileURLToPath(new URL("../packages/design-system", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts", "app/**/*.test.{ts,tsx}", "shared/**/*.test.ts"],
    testTimeout: 20000,
  },
});
