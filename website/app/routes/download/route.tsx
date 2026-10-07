import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, isLang, localized, useLang, useMessages } from "~/i18n/core";
import { Badge, Breath, ExternalLink, OrbMark, TextLink, cx } from "~/design-system/components";
import { GITHUB_RELEASES } from "~/components/i18n";
import { Markdown } from "~/components/markdown/Markdown";
import { fetchReleases, findAsset, formatBytes, pickLatest, type Release } from "~/lib/github";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

type Lang = "zh" | "en";
type State = { status: "loading" } | { status: "error" } | { status: "ready"; latest: Release | undefined };

function useLatest(): [State, () => void] {
  const [state, setState] = useState<State>({ status: "loading" });
  const load = useCallback((force = false) => {
    setState({ status: "loading" });
    fetchReleases({ force })
      .then((releases) => setState({ status: "ready", latest: pickLatest(releases) || undefined }))
      .catch(() => setState({ status: "error" }));
  }, []);
  useEffect(() => load(), [load]);
  return [state, () => load(true)];
}

const PLATFORMS = ["android", "windows", "linux"] as const;
type Platform = (typeof PLATFORMS)[number];
const isPlatform = (s: string): s is Platform => (PLATFORMS as readonly string[]).includes(s);

/** 地址里的 #windows 这类锚点优先（文档可以直接链到某个平台），否则按访客的系统挑；认不出的（苹果设备等）给安卓。 */
function detectPlatform(): Platform {
  const hash = location.hash.slice(1);
  if (isPlatform(hash)) return hash;
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return "android";
}

// 每个平台的完整步骤
const GUIDE: Record<Platform, string> = { android: "/docs/start/install", windows: "/docs/advanced/windows", linux: "/docs/advanced/other-machines" };

// 预渲染的 HTML 里就有这个链接，不依赖脚本（旧手机的浏览器跑不动页面脚本也能下载），由 Worker 302 到最新正式发布的 APK
const LATEST_APK = "/dl/latest/android.apk";

const quietLink = "underline decoration-border-strong underline-offset-4 transition-colors duration-(--ds-duration-fast) hover:text-fg";

export default function Download() {
  const t = useMessages(messages);
  const lang = useLang();
  const [state, retry] = useLatest();
  const latest = state.status === "ready" ? state.latest : undefined;
  // 预渲染的 HTML 里是安卓：跑不动页面脚本的旧手机也能拿到 APK 链接；水合后换成访客的系统
  const [platform, setPlatform] = useState<Platform>("android");
  useEffect(() => setPlatform(detectPlatform()), []);
  const choose = (p: Platform) => { setPlatform(p); history.replaceState(null, "", `#${p}`); };
  const [notesOpen, setNotesOpen] = useState(false);
  const navigate = useNavigate();
  // 点了下载 APK 之后带用户去安装说明：浏览器已经开始下载，页面本身留在原地
  const afterDownload = () => { setTimeout(() => navigate(localized(lang, GUIDE.android)), 800); };
  const guide = <TextLink to={localized(lang, GUIDE[platform])} className="text-fg-subtle decoration-transparent hover:text-fg">{t.guide} →</TextLink>;
  const apk = latest && findAsset(latest, "apk");
  const x64 = latest && findAsset(latest, "windows-x64"), arm = latest && findAsset(latest, "windows-arm64");
  const notes = latest ? notesForLang(latest.body, lang).trim() : "";

  return (
    <section className="relative overflow-hidden">
      <div className="relative mx-auto flex min-h-[calc(100dvh-var(--ds-header-height))] isolate max-w-content flex-col items-center justify-center px-6 py-12 text-center short:min-h-0 short:py-10"> {/* ds-allow：高度表达式只引用变量 */}
        {/* 光团与它身后的一圈呼吸光：页面上唯一的颜色。这一列自成层叠上下文（isolate），呼吸光压在最底层（-z-10），名字再盖在光团的光晕之上，文字都不被光晕罩住 */}
        <div className="relative">
          <Breath size="lg" className="left-1/2 top-1/2 -z-10 -translate-x-1/2 -translate-y-1/2" />
          {/* 与控制台首页的球同比例：球体约占屏宽三成（SVG 里球的直径是画布的 48%，其余是光晕） */}
          <OrbMark size={224} className="relative size-56 sm:size-64" />
        </div>
        <h1 className="relative -mt-4 text-5xl font-semibold tracking-tight text-fg-display text-shadow-display sm:text-7xl">{t.heading}</h1>
        <p className="mt-4 text-lg text-fg-muted sm:text-xl">{t.lead}</p>

        <div role="tablist" aria-label={t.tabsLabel} className="mt-12 inline-flex rounded-full border border-border p-1">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              id={`tab-${p}`}
              aria-selected={platform === p}
              aria-controls="platform-panel"
              onClick={() => choose(p)}
              className={cx(
                "rounded-full px-5 py-1.5 text-sm transition-colors duration-(--ds-duration-fast) sm:px-7",
                platform === p ? "bg-surface-hover font-medium text-fg" : "text-fg-subtle hover:text-fg",
              )}
            >
              {t.platforms[p].tab}
            </button>
          ))}
        </div>

        {/* 三个平台高度相近：切换时下面的内容不跳 */}
        <div id="platform-panel" role="tabpanel" aria-labelledby={`tab-${platform}`} className="mt-8 flex min-h-32 w-full flex-col items-center gap-4">
          {platform === "android" && (
            <>
              {/* 胶囊形，与命令框同形；按钮基类是 rounded-md，覆盖不了，单独写 */}
              <a href={apk?.url ?? LATEST_APK} onClick={afterDownload} className="inline-flex h-12 items-center justify-center rounded-full bg-accent px-10 text-base font-medium text-accent-fg shadow-glow transition-colors duration-(--ds-duration-fast) hover:bg-accent-hover focus-visible:shadow-ring">
                {t.platforms.android.download}
              </a>
              <Meta>{t.platforms.android.meta}{apk && <> · {formatBytes(apk.size, lang)}</>}<Dot />{guide}</Meta>
            </>
          )}
          {platform === "windows" && (
            <>
              <Command command={t.platforms.windows.command} copy={t.copy} copied={t.copied} />
              {x64 && (
                <p className="text-sm text-fg-muted">
                  <a href={x64.url} className={quietLink}>{t.platforms.windows.installer}</a>
                  {arm && <><Dot /><a href={arm.url} className={quietLink}>{t.platforms.windows.arm64}</a></>}
                </p>
              )}
              <Meta>{t.platforms.windows.meta}<Dot />{guide}</Meta>
            </>
          )}
          {platform === "linux" && (
            <>
              <Command command={t.platforms.linux.command} copy={t.copy} copied={t.copied} />
              <Meta>{t.platforms.linux.meta}<Dot />{guide}</Meta>
            </>
          )}
        </div>

        {/* 版本：一行小字；更新内容按需展开 */}
        <div className="mt-16 flex w-full flex-col items-center gap-6 text-xs text-fg-subtle">
          {state.status === "error" && (
            <p>
              {t.state.error}<Dot /><button type="button" onClick={retry} className="hover:text-fg">{t.state.retry}</button>
              <Dot /><ExternalLink href={GITHUB_RELEASES} className="text-fg-subtle decoration-transparent hover:text-fg">{t.latest.all} ↗</ExternalLink>
            </p>
          )}
          {latest && (
            <p className="flex flex-wrap items-center justify-center gap-y-1">
              <span className="tabular-nums">{latest.version}</span>
              {latest.prerelease && <Badge tone="warning" className="ml-2">{t.latest.prerelease}</Badge>}
              <Dot /><time dateTime={latest.publishedAt}>{new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", { dateStyle: "medium" }).format(new Date(latest.publishedAt))}</time>
              <Dot /><button type="button" aria-expanded={notesOpen} onClick={() => setNotesOpen((v) => !v)} className="hover:text-fg">{t.latest.notes} {notesOpen ? "−" : "+"}</button>
              <Dot /><ExternalLink href={GITHUB_RELEASES} className="text-fg-subtle decoration-transparent hover:text-fg">{t.latest.all} ↗</ExternalLink>
            </p>
          )}
          {latest && notesOpen && (
            <div className="w-full max-w-prose border-t border-border pt-6 text-left text-sm text-fg-muted">
              {notes ? <Markdown source={notes} /> : <p>{t.latest.empty}</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Dot() {
  return <span aria-hidden className="px-2">·</span>;
}

function Meta({ children }: { children: ReactNode }) {
  return <p className="text-xs text-fg-subtle">{children}</p>;
}

/** 一行命令：胶囊形，窄屏横向滚动不折行；右侧复制，复制后短暂变成对勾。 */
function Command({ command, copy, copied }: { command: string; copy: string; copied: string }) {
  const [done, setDone] = useState(false);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(command); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* 剪贴板不可用 */ }
  };
  return (
    <div className="flex w-fit max-w-full items-center gap-2 rounded-full border border-border bg-surface py-1.5 pl-6 pr-1.5">
      <code className="min-w-0 overflow-x-auto whitespace-nowrap py-2 text-left font-mono text-sm text-fg [scrollbar-width:none]">{command}</code>
      <button type="button" onClick={onCopy} aria-label={done ? copied : copy} title={done ? copied : copy} className="flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors duration-(--ds-duration-fast) hover:bg-surface-hover hover:text-fg">
        {done ? (
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M10.5 2.5h-6a2 2 0 0 0-2 2v6" strokeLinecap="round" /></svg>
        )}
      </button>
    </div>
  );
}

/** 发布说明里中英文各写一条（CHANGELOG 的约定）：按当前语言只留一种。含汉字的条目算中文。 */
function notesForLang(body: string, lang: Lang): string {
  const cjk = /[㐀-鿿]/;
  return body.split("\n").filter((line) => !/^\s*[-*]\s/.test(line) || cjk.test(line) === (lang === "zh")).join("\n");
}
