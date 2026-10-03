import type { Config } from "@react-router/dev/config";
import { prerenderPaths } from "./app/lib/prerender";

// 纯静态站：没有运行时服务端，所有页面在构建时预渲染为 HTML（build/client/）。
export default {
  ssr: false,
  prerender: async () => prerenderPaths(),
} satisfies Config;
