// 站点地图的唯一真源：路由表（routes.ts）、预渲染清单（prerender.ts）、文档侧栏与文档总览都读这里。
// 默认语言（中文）在根路径，英文在 /en 下；两种语言的路径一一对应。
import type { Lang } from "~/i18n/core";
import moved from "./moved.json";

export type DocSection = "start" | "guide" | "advanced" | "reference";

export type DocEntry = {
  /** 不带语言前缀的站内路径 */
  path: string;
  /** app/routes/docs/ 下的目录名 */
  dir: string;
  section: DocSection;
  label: Record<Lang, string>;
  /** 文档总览里的一句话 */
  summary: Record<Lang, string>;
};

export const DOC_NAV: DocEntry[] = [
  {
    path: "/docs",
    dir: "index",
    section: "start",
    label: { zh: "文档总览", en: "Overview" },
    summary: { zh: "从安装到看见他，只有三步。", en: "Three steps from install to seeing your agent." },
  },
  {
    path: "/docs/start/install",
    dir: "install",
    section: "start",
    label: { zh: "安装", en: "Install" },
    summary: { zh: "一行命令。装好之后已经接在宿主上。", en: "One command. When it finishes, it is already connected." },
  },
  {
    path: "/docs/start/connect",
    dir: "connect",
    section: "start",
    label: { zh: "接上宿主", en: "Connect a host" },
    summary: { zh: "接上是一条命令，撤销也是一条。", en: "One command to connect, one to undo." },
  },
  {
    path: "/docs/guide/in-host",
    dir: "in-host",
    section: "guide",
    label: { zh: "在宿主里怎么用", en: "Inside the host" },
    summary: { zh: "日常的六件事，各是一句话。", en: "Six everyday things, one sentence each." },
  },
  {
    path: "/docs/guide/governance",
    dir: "governance",
    section: "guide",
    label: { zh: "治理面", en: "Governance view" },
    summary: { zh: "只有看和签。亲手签下你的底线。", en: "Look and sign. Sign your bottom lines by hand." },
  },
  {
    path: "/docs/guide/devices",
    dir: "devices",
    section: "guide",
    label: { zh: "多设备", en: "More devices" },
    summary: { zh: "新设备上是同一个他。", en: "The same agent on a new device." },
  },
  {
    path: "/docs/guide/export",
    dir: "export",
    section: "guide",
    label: { zh: "带走与恢复", en: "Export and restore" },
    summary: { zh: "整个带走，再从那一份恢复。", en: "Take everything with you, and restore from it." },
  },
  {
    path: "/docs/guide/trust",
    dir: "trust",
    section: "guide",
    label: { zh: "安全与信任", en: "Security and trust" },
    summary: { zh: "签名的发布物，端到端加密，抹除是真删。", en: "Signed releases, end-to-end encryption, real erasure." },
  },
  {
    path: "/docs/advanced/self-host-hub",
    dir: "self-host-hub",
    section: "advanced",
    label: { zh: "自建 Hub", en: "Self-host a Hub" },
    summary: { zh: "在你自己的机器上转发密文。", en: "Relay ciphertext on a machine you own." },
  },
  {
    path: "/docs/reference/commands",
    dir: "commands",
    section: "reference",
    label: { zh: "命令速查", en: "Commands" },
    summary: { zh: "终端里的每一行。", en: "Every line you can type in the terminal." },
  },
  {
    path: "/docs/reference/release-signing",
    dir: "release-signing",
    section: "reference",
    label: { zh: "发布签名与校验", en: "Release signing" },
    summary: { zh: "公钥，以及自己动手验签的命令。", en: "The public key and commands to verify by hand." },
  },
];

export const SECTION_ORDER: DocSection[] = ["start", "guide", "advanced", "reference"];

/** 已删除页面的去向：旧地址 → 新地址（postbuild 读同一份 moved.json 写进 _redirects，两种语言各一条）。 */
export const MOVED: [string, string][] = moved.map(([from = "", to = ""]): [string, string] => [from, to]);

/** 除文档外的页面：路径 → app/routes/ 下的模块。 */
export const TOP_PAGES: { path: string; file: string }[] = [
  { path: "/", file: "routes/home/route.tsx" },
  { path: "/download", file: "routes/download/route.tsx" },
];

export const PAGE_PATHS: string[] = [...TOP_PAGES.map((p) => p.path), ...DOC_NAV.map((d) => d.path)];

export function localizedPath(lang: Lang, path: string): string {
  if (lang === "zh") return path;
  return path === "/" ? "/en" : `/en${path}`;
}

/** 「页面不存在」的两个预渲染地址（各自成为那种语言的 404.html）。 */
export const NOT_FOUND_PATHS = ["/404", "/en/404"];

/** 预渲染清单：中文页面 + 对应的 /en 页面，外加两种语言的 404。 */
export function prerenderPaths(): string[] {
  const out = new Set<string>(NOT_FOUND_PATHS);
  for (const path of PAGE_PATHS) {
    out.add(path);
    out.add(localizedPath("en", path));
  }
  return [...out].sort();
}

export function docIndex(path: string): number {
  return DOC_NAV.findIndex((d) => d.path === path);
}

export type NavGroup = { section: DocSection; items: DocEntry[] };

export function navGroups(): NavGroup[] {
  return SECTION_ORDER.map((section) => ({ section, items: DOC_NAV.filter((d) => d.section === section) }));
}

const bareOf = (pathname: string): string => {
  const bare = pathname === "/en" ? "/" : pathname.startsWith("/en/") ? pathname.slice(3) : pathname;
  return bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;
};

/** 这个地址是不是站内的一个页面（不带语言前缀比较）。 */
export function isKnownPath(pathname: string): boolean {
  return PAGE_PATHS.includes(bareOf(pathname));
}

/** 文档页用阅读模式：光学地平线换成更高更柔的那一版，导航换成阅读刻度。 */
export function isReadingPath(pathname: string): boolean {
  const bare = bareOf(pathname);
  return DOC_NAV.some((d) => d.path === bare);
}
