import type { Config } from "@react-router/dev/config";
import { prerenderPaths } from "./app/lib/prerender";

// 没有运行时服务端：构建时把每个语言 × 每个页面渲染成 HTML（build/client/）。
export default {
  ssr: false,
  prerender: async () => prerenderPaths(),
} satisfies Config;
