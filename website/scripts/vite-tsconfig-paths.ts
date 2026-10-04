// 极简的 "~/*" → "app/*" 别名解析，避免再引入一个依赖。
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const appDir = fileURLToPath(new URL("../app/", import.meta.url));

export default function tsconfigPaths(): Plugin {
  return {
    name: "quetzal-tsconfig-paths",
    config: () => ({ resolve: { alias: { "~": appDir.replace(/\/$/, "") } } }),
  };
}
