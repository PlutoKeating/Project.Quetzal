import { prerenderPaths as allPaths } from "./pages";

// react-router.config.ts 在构建时（Node）调用；清单来自 app/lib/pages.ts（纯数据，无 React 依赖）。
export async function prerenderPaths(): Promise<string[]> {
  return allPaths();
}
