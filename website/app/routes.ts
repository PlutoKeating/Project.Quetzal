import { type RouteConfig, index, route } from "@react-router/dev/routes";

// 默认语言（中文）在根路径，英文在 /en 下；两种语言共用同一个页面模块，语言由 useLang() 从路径判断。
const PAGES: [string, string][] = [
  ["download", "routes/download/route.tsx"],
  ["docs", "routes/docs/index/route.tsx"],
  ["docs/start/install", "routes/docs/install/route.tsx"],
  ["docs/guide/trust", "routes/docs/trust/route.tsx"],
  ["docs/guide/multi-body", "routes/docs/multi-body/route.tsx"],
  ["docs/advanced/linux", "routes/docs/linux/route.tsx"],
  ["docs/advanced/macos", "routes/docs/macos/route.tsx"],
  ["docs/advanced/windows", "routes/docs/windows/route.tsx"],
  ["docs/advanced/other-machines", "routes/docs/other-machines/route.tsx"],
  ["docs/advanced/custom-adapter", "routes/docs/custom-adapter/route.tsx"],
  ["docs/reference/release-signing", "routes/docs/release-signing/route.tsx"],
  ["docs/reference/spine-backup", "routes/docs/spine-backup/route.tsx"],
];

export default [
  index("routes/home/route.tsx"),
  route("en", "routes/home/route.tsx", { id: "home-en" }),
  route("404", "routes/not-found.tsx"),
  ...PAGES.map(([path, file]) => route(path, file)),
  ...PAGES.map(([path, file]) => route(`en/${path}`, file, { id: `en-${path}` })),
  route("*", "routes/not-found.tsx", { id: "catch-all" }),
] satisfies RouteConfig;
