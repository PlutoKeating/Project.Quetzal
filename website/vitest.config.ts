import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Worker 单测：不起 react-router 插件（它会把 app/ 当路由树编译），只跑纯 TS 逻辑。
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts", "app/**/*.test.ts", "shared/**/*.test.ts"],
    testTimeout: 20000,
  },
});
