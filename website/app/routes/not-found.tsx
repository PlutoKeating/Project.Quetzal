import type { Route } from "./+types/not-found";
import { NotFound } from "~/components/NotFound";

export const meta: Route.MetaFunction = () => [{ title: "404 · Windler" }, { name: "robots", content: "noindex" }];

/** 预渲染为 /404/index.html，构建后复制为根目录 404.html 供 Workers 静态资源兜底。 */
export default function NotFoundRoute() {
  return <NotFound />;
}
