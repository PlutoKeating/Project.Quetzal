import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/lang-redirect.tsx"),
  route("404", "routes/not-found.tsx"),
  // 不带语言的入口（身体与 App 给出的链接 /device?code=…、同步服务跳来的 /account）：按访客语言转到 /:lang/account/…
  route("device", "routes/lang-forward.tsx", { id: "forward-device" }),
  route("account", "routes/lang-forward.tsx", { id: "forward-account" }),
  ...prefix(":lang", [
    layout("routes/layout.tsx", [
      index("routes/home/route.tsx"),
      route("features", "routes/features/route.tsx"),
      route("download", "routes/download/route.tsx"),
      route("about", "routes/about/route.tsx"),
      route("terms", "routes/terms/route.tsx"),
      route("privacy", "routes/privacy/route.tsx"),
      route("docs/*", "routes/docs/route.tsx"),
      route("account", "routes/account/route.tsx"),
      route("account/device", "routes/account/device/route.tsx"),
      route("account/consoles", "routes/account/consoles/route.tsx"),
      route("account/settings", "routes/account/settings/route.tsx"),
    ]),
  ]),
  route("*", "routes/catch-all.tsx"),
] satisfies RouteConfig;
