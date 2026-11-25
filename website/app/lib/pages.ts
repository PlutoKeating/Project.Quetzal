// 站点地图的唯一真源：路由表（routes.ts）、预渲染清单（prerender.ts）与文档侧栏都读这里。
// 默认语言（中文）在根路径，英文在 /en 下；两种语言的路径一一对应。
import type { Lang } from "~/i18n/core";

export type DocSection = "start" | "guide" | "advanced" | "reference";

export type DocEntry = {
  path: string;
  section: DocSection;
  label: Record<Lang, string>;
};

export const DOC_NAV: DocEntry[] = [
  { path: "/docs", section: "start", label: { zh: "文档总览", en: "Documentation" } },
  {
    path: "/docs/start/install",
    section: "start",
    label: { zh: "安装 Quetzalcoatl", en: "Install Quetzalcoatl" },
  },
  { path: "/docs/guide/trust", section: "guide", label: { zh: "良知与权限", en: "Conscience & permissions" } },
  { path: "/docs/guide/multi-body", section: "guide", label: { zh: "多身体与群组", en: "Multi-body & groups" } },
  { path: "/docs/advanced/linux", section: "advanced", label: { zh: "Linux（GTK4）", en: "Linux (GTK4)" } },
  { path: "/docs/advanced/macos", section: "advanced", label: { zh: "macOS（SwiftUI）", en: "macOS (SwiftUI)" } },
  { path: "/docs/advanced/windows", section: "advanced", label: { zh: "Windows（WinUI 3）", en: "Windows (WinUI 3)" } },
  { path: "/docs/advanced/other-machines", section: "advanced", label: { zh: "服务器与无界面机器", en: "Servers & headless machines" } },
  { path: "/docs/advanced/custom-adapter", section: "advanced", label: { zh: "自定义 Agent 适配器", en: "Custom agent adapters" } },
  {
    path: "/docs/reference/release-signing",
    section: "reference",
    label: { zh: "发布签名与校验", en: "Release signing & verification" },
  },
  { path: "/docs/reference/spine-backup", section: "reference", label: { zh: "脊柱、导出与备份", en: "Spine, export & backup" } },
];

export const SECTION_ORDER: DocSection[] = ["start", "guide", "advanced", "reference"];

const primary = ["/", "/download", ...DOC_NAV.map((d) => d.path)];

export const PAGE_PATHS: string[] = primary;

/** 预渲染清单：中文页面 + 对应的 /en 页面，外加 404。 */
export function prerenderPaths(): string[] {
  const out = new Set<string>(["/404"]);
  for (const path of primary) {
    out.add(path);
    out.add(path === "/" ? "/en" : `/en${path}`);
  }
  return [...out].sort();
}

export function localizedPath(lang: Lang, path: string): string {
  if (lang === "zh") return path;
  return path === "/" ? "/en" : `/en${path}`;
}

export function docIndex(path: string): number {
  return DOC_NAV.findIndex((d) => d.path === path);
}

export type NavGroup = { section: DocSection; items: DocEntry[] };

export function navGroups(): NavGroup[] {
  return SECTION_ORDER.map((section) => ({ section, items: DOC_NAV.filter((d) => d.section === section) }));
}
