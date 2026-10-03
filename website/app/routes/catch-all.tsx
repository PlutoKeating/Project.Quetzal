import { NotFound } from "~/components/NotFound";

/** 客户端导航到不存在的路径时显示（静态托管下未知路径由 404.html 兜底）。 */
export default function CatchAll() {
  return <NotFound />;
}
