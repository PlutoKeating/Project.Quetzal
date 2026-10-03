import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";

export default [
  index("routes/lang-redirect.tsx"),
  route("404", "routes/not-found.tsx"),
  ...prefix(":lang", [
    layout("routes/layout.tsx", [
      index("routes/home/route.tsx"),
      route("features", "routes/features/route.tsx"),
      route("download", "routes/download/route.tsx"),
      route("about", "routes/about/route.tsx"),
      route("terms", "routes/terms/route.tsx"),
      route("privacy", "routes/privacy/route.tsx"),
      route("docs/*", "routes/docs/route.tsx"),
    ]),
  ]),
  route("*", "routes/catch-all.tsx"),
] satisfies RouteConfig;
