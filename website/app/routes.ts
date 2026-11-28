import { type RouteConfig, index, route } from "@react-router/dev/routes";
import { DOC_NAV, TOP_PAGES } from "./lib/pages";

// 默认语言（中文）在根路径，英文在 /en 下；两种语言共用同一个页面模块，语言由 useLang() 从路径判断。
// 页面清单的唯一真源是 lib/pages.ts。
const PAGES: [string, string][] = [
  ...TOP_PAGES.filter((p) => p.path !== "/").map((p): [string, string] => [p.path.slice(1), p.file]),
  ...DOC_NAV.map((d): [string, string] => [d.path.slice(1), `routes/docs/${d.dir}/route.tsx`]),
];

// 没有单独的 /404 路由：/404 与 /en/404 预渲染时落在通配路由上，产物被复制成 404.html 与 en/404.html。
// 这样它在任意不存在的地址上水合时，客户端匹配到的是同一条路由，不会出现水合不一致。
export default [
  index("routes/home/route.tsx"),
  route("en", "routes/home/route.tsx", { id: "home-en" }),
  ...PAGES.map(([path, file]) => route(path, file)),
  ...PAGES.map(([path, file]) => route(`en/${path}`, file, { id: `en-${path}` })),
  route("*", "routes/not-found.tsx", { id: "catch-all" }),
] satisfies RouteConfig;
