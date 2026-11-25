// 官网的唯一设计令牌来源：颜色、字体、间距、字号、动效都在这里。
// 页面与组件只写 class（见下面的 globalCss），不得出现任何字面色值——
// website/app/design-system/designSystem.test.ts 会扫描 app/ 下的源码，发现 #RRGGBB / rgb() 就报错。
//
// 视觉语言（第一性原理蓝图 docs/V2_GOAL.html 的延续）：白纸、深墨、钴蓝为主、青绿为证，
// 0px 圆角、开放细线、没有阴影堆叠；不加载任何第三方字体或 CDN，只用系统字体栈。

export const tokens = {
  color: {
    paper: "#FFFFFF",
    paperAlt: "#F7F8FA",
    paperSink: "#EEF1F5",
    ink: "#0F172A",
    inkSoft: "#334155",
    mute: "#5A6577",
    hair: "#D5DBE3",
    hairStrong: "#AEB8C6",
    accent: "#1D4ED8",
    accentText: "#1E3A8A",
    accentSink: "#E8EEFC",
    teal: "#0D9488",
    tealText: "#115E59",
    tealSink: "#E4F5F2",
    warn: "#B45309",
    warnSink: "#FDF3E3",
    danger: "#B42318",
    codeBg: "#0F172A",
    codeInk: "#E6EDF7",
    codeMute: "#93A4BC",
  },
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
  size: {
    xs: "0.75rem",
    sm: "0.875rem",
    base: "1rem",
    lg: "1.125rem",
    xl: "1.375rem",
    h3: "1.5rem",
    h2: "1.875rem",
    h1: "2.5rem",
    hero: "3.25rem",
    mono: "0.8125rem",
  },
  space: {
    xxs: "4px",
    xs: "8px",
    sm: "12px",
    md: "16px",
    lg: "24px",
    xl: "32px",
    xxl: "48px",
    xxxl: "72px",
    huge: "96px",
  },
  line: {
    body: "1.75",
    tight: "1.25",
    heading: "1.2",
  },
  layout: {
    wrap: "1120px",
    prose: "72ch",
    narrow: "760px",
    docSide: "248px",
    header: "64px",
  },
  radius: { none: "0px" },
  duration: { fast: "120ms", base: "180ms" },
} as const;

const v = (name: string): string => `var(--ds-${name})`;

/** 全站样式：一次性注入 <style>，不需要 Tailwind，也没有任何运行时样式依赖。 */
export const globalCss = `
:root {
  --ds-paper: ${tokens.color.paper};
  --ds-paper-alt: ${tokens.color.paperAlt};
  --ds-paper-sink: ${tokens.color.paperSink};
  --ds-ink: ${tokens.color.ink};
  --ds-ink-soft: ${tokens.color.inkSoft};
  --ds-mute: ${tokens.color.mute};
  --ds-hair: ${tokens.color.hair};
  --ds-hair-strong: ${tokens.color.hairStrong};
  --ds-accent: ${tokens.color.accent};
  --ds-accent-text: ${tokens.color.accentText};
  --ds-accent-sink: ${tokens.color.accentSink};
  --ds-teal: ${tokens.color.teal};
  --ds-teal-text: ${tokens.color.tealText};
  --ds-teal-sink: ${tokens.color.tealSink};
  --ds-warn: ${tokens.color.warn};
  --ds-warn-sink: ${tokens.color.warnSink};
  --ds-danger: ${tokens.color.danger};
  --ds-code-bg: ${tokens.color.codeBg};
  --ds-code-ink: ${tokens.color.codeInk};
  --ds-code-mute: ${tokens.color.codeMute};
  --ds-font-sans: ${tokens.font.sans};
  --ds-font-mono: ${tokens.font.mono};
  --ds-wrap: ${tokens.layout.wrap};
  --ds-prose: ${tokens.layout.prose};
  --ds-narrow: ${tokens.layout.narrow};
  --ds-doc-side: ${tokens.layout.docSide};
  --ds-header: ${tokens.layout.header};
  --ds-fast: ${tokens.duration.fast};
  --ds-base: ${tokens.duration.base};
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; } }
body {
  margin: 0;
  background: ${v("paper")};
  color: ${v("ink")};
  font-family: ${v("font-sans")};
  font-size: ${tokens.size.base};
  line-height: ${tokens.line.body};
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: ${v("accent-text")}; text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: ${v("accent")}; }
img, svg { max-width: 100%; vertical-align: middle; }
hr { border: 0; border-top: 1px solid ${v("hair")}; margin: ${v("xl")} 0; }
::selection { background: ${v("accent-sink")}; color: ${v("ink")}; }
:focus-visible { outline: 2px solid ${v("accent")}; outline-offset: 2px; }

.wrap { width: min(100% - 40px, ${v("wrap")}); margin: 0 auto; }
.skip { position: absolute; left: -9999px; top: 0; background: ${v("ink")}; color: ${v("paper")}; padding: ${v("sm")} ${v("md")}; z-index: 50; }
.skip:focus { left: 16px; top: 16px; }

/* ---------------------------------------------------------------- header */
.site-head { position: sticky; top: 0; z-index: 20; background: rgba(255,255,255,0.94); backdrop-filter: saturate(140%) blur(8px); border-bottom: 1px solid ${v("hair")}; }
.head-inner { display: flex; align-items: center; gap: ${v("lg")}; min-height: ${v("header")}; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: ${v("ink")}; text-decoration: none; font-weight: 650; letter-spacing: -0.01em; }
.brand:hover { color: ${v("ink")}; }
.brand-sub { color: ${v("mute")}; font-size: ${tokens.size.xs}; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; }
.nav { display: flex; align-items: center; gap: ${v("lg")}; margin-left: auto; flex-wrap: wrap; }
.nav a { color: ${v("ink-soft")}; text-decoration: none; font-size: ${tokens.size.sm}; padding: 6px 0; border-bottom: 1px solid transparent; transition: color ${v("fast")}, border-color ${v("fast")}; }
.nav a:hover { color: ${v("ink")}; }
.nav a[aria-current="page"] { color: ${v("ink")}; border-bottom-color: ${v("accent")}; }
.head-tools { display: flex; align-items: center; gap: ${v("md")}; }
.lang-switch { font-size: ${tokens.size.sm}; color: ${v("mute")}; text-decoration: none; border: 1px solid ${v("hair")}; padding: 5px 10px; border-radius: ${v("none")}; }
.lang-switch:hover { border-color: ${v("hair-strong")}; color: ${v("ink")}; }
@media (max-width: 720px) {
  .brand-sub { display: none; }
  .nav { gap: ${v("md")}; }
  .nav .nav-hide { display: none; }
}

/* ---------------------------------------------------------------- hero / home */
.hero { padding: ${v("xxxl")} 0 ${v("xxl")}; border-bottom: 1px solid ${v("hair")}; }
.hero-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: ${v("xxl")}; align-items: start; }
.eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: ${tokens.size.xs}; letter-spacing: 0.14em; text-transform: uppercase; color: ${v("teal-text")}; font-weight: 600; }
.eyebrow::before { content: ""; width: 18px; height: 1px; background: ${v("teal")}; }
h1, h2, h3, h4 { margin: 0; line-height: ${tokens.line.heading}; letter-spacing: -0.02em; font-weight: 650; }
h1 { font-size: clamp(2.1rem, 4.6vw, ${tokens.size.hero}); letter-spacing: -0.03em; }
h2 { font-size: clamp(1.55rem, 2.6vw, ${tokens.size.h2}); }
h3 { font-size: ${tokens.size.h3}; }
.hero h1 { margin: ${v("md")} 0 ${v("md")}; }
.hero .lead { font-size: ${tokens.size.lg}; color: ${v("ink-soft")}; max-width: ${v("prose")}; margin: 0 0 ${v("lg")}; }
.hero-actions { display: flex; flex-wrap: wrap; gap: ${v("sm")}; align-items: center; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 11px 18px; border: 1px solid ${v("accent")}; background: ${v("accent")}; color: ${v("paper")}; text-decoration: none; font-weight: 600; font-size: ${tokens.size.sm}; border-radius: ${v("none")}; transition: background ${v("fast")}, border-color ${v("fast")}; }
.btn:hover { background: ${v("accent-text")}; border-color: ${v("accent-text")}; color: ${v("paper")}; }
.btn.ghost { background: transparent; color: ${v("ink")}; border-color: ${v("hair-strong")}; }
.btn.ghost:hover { border-color: ${v("ink")}; color: ${v("ink")}; }
.hero-aside { border: 1px solid ${v("hair")}; padding: ${v("lg")}; background: ${v("paper-alt")}; }
.hero-aside h2 { font-size: ${tokens.size.base}; text-transform: uppercase; letter-spacing: 0.1em; color: ${v("mute")}; font-weight: 600; }
.hero-aside ul { list-style: none; margin: ${v("sm")} 0 0; padding: 0; }
.hero-aside li { display: flex; justify-content: space-between; gap: ${v("md")}; padding: 9px 0; border-bottom: 1px solid ${v("hair")}; font-size: ${tokens.size.sm}; }
.hero-aside li:last-child { border-bottom: 0; }
.hero-aside code { font-family: ${v("font-mono")}; font-size: ${tokens.size.mono}; color: ${v("ink")}; }
.hero-aside .ok { color: ${v("teal-text")}; font-weight: 600; }
@media (max-width: 900px) { .hero-grid { grid-template-columns: 1fr; } }

.section { padding: ${v("xxl")} 0; border-bottom: 1px solid ${v("hair")}; }
.section:last-of-type { border-bottom: 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: ${v("md")}; margin-bottom: ${v("lg")}; }
.section-head p { margin: 0; color: ${v("mute")}; font-size: ${tokens.size.sm}; max-width: 46ch; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: ${v("hair")}; border: 1px solid ${v("hair")}; }
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.card { background: ${v("paper")}; padding: ${v("lg")}; display: flex; flex-direction: column; gap: ${v("xs")}; }
.card .kicker { font-size: ${tokens.size.xs}; letter-spacing: 0.12em; text-transform: uppercase; color: ${v("teal-text")}; font-weight: 600; }
.card h3 { font-size: ${tokens.size.lg}; }
.card p { margin: 0; color: ${v("ink-soft")}; font-size: ${tokens.size.sm}; line-height: 1.7; }
.card a { margin-top: auto; font-size: ${tokens.size.sm}; }
@media (max-width: 900px) { .grid, .grid.two { grid-template-columns: 1fr; } }

/* ---------------------------------------------------------------- prose / docs */
.prose { max-width: ${v("prose")}; }
.prose p { margin: 0 0 ${v("md")}; color: ${v("ink-soft")}; }
.prose h2 { margin: ${v("xl")} 0 ${v("sm")}; padding-top: ${v("md")}; border-top: 1px solid ${v("hair")}; font-size: ${tokens.size.h3}; }
.prose h2:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
.prose h3 { margin: ${v("lg")} 0 ${v("xs")}; font-size: ${tokens.size.lg}; }
.prose ul, .prose ol { margin: 0 0 ${v("md")}; padding-left: 1.4em; color: ${v("ink-soft")}; }
.prose li { margin: 6px 0; }
.prose strong { color: ${v("ink")}; font-weight: 650; }
.prose code, .inline-code { font-family: ${v("font-mono")}; font-size: ${tokens.size.mono}; background: ${v("paper-sink")}; border: 1px solid ${v("hair")}; padding: 1px 5px; color: ${v("ink")}; overflow-wrap: anywhere; }
.prose .lead { font-size: ${tokens.size.lg}; color: ${v("ink-soft")}; }
.prose table { width: 100%; border-collapse: collapse; margin: 0 0 ${v("lg")}; font-size: ${tokens.size.sm}; }
.prose th, .prose td { text-align: left; padding: 9px 12px; border-bottom: 1px solid ${v("hair")}; vertical-align: top; }
.prose th { color: ${v("ink")}; font-weight: 650; border-bottom-color: ${v("hair-strong")}; }
.prose td { color: ${v("ink-soft")}; }
.prose table code { white-space: nowrap; }

.doc-shell { display: grid; grid-template-columns: ${v("doc-side")} minmax(0, 1fr); gap: ${v("xxl")}; padding: ${v("xl")} 0 ${v("xxxl")}; }
.doc-side { position: sticky; top: calc(${v("header")} + 16px); align-self: start; max-height: calc(100vh - ${v("header")} - 32px); overflow: auto; padding-right: ${v("md")}; }
.doc-side h2 { font-size: ${tokens.size.xs}; letter-spacing: 0.12em; text-transform: uppercase; color: ${v("mute")}; font-weight: 600; margin: ${v("lg")} 0 ${v("xs")}; }
.doc-side h2:first-child { margin-top: 0; }
.doc-side ul { list-style: none; margin: 0; padding: 0; }
.doc-side li { margin: 2px 0; }
.doc-side a { display: block; padding: 5px 8px; margin-left: -8px; color: ${v("ink-soft")}; text-decoration: none; font-size: ${tokens.size.sm}; border-left: 2px solid transparent; }
.doc-side a:hover { color: ${v("ink")}; background: ${v("paper-alt")}; }
.doc-side a[aria-current="page"] { color: ${v("accent-text")}; border-left-color: ${v("accent")}; background: ${v("accent-sink")}; font-weight: 600; }
.doc-title { margin-bottom: ${v("lg")}; padding-bottom: ${v("md")}; border-bottom: 1px solid ${v("hair")}; }
.doc-title h1 { font-size: clamp(1.8rem, 3.4vw, ${tokens.size.h2}); margin-bottom: ${v("xs")}; }
.doc-title p { margin: 0; color: ${v("mute")}; }
.doc-foot { margin-top: ${v("xxl")}; padding-top: ${v("md")}; border-top: 1px solid ${v("hair")}; display: flex; justify-content: space-between; gap: ${v("md")}; flex-wrap: wrap; font-size: ${tokens.size.sm}; }
@media (max-width: 900px) {
  .doc-shell { grid-template-columns: 1fr; gap: ${v("lg")}; }
  .doc-side { position: static; max-height: none; border-bottom: 1px solid ${v("hair")}; padding-bottom: ${v("md")}; }
}

/* ---------------------------------------------------------------- blocks */
.codeblock { margin: 0 0 ${v("lg")}; border: 1px solid ${v("hair")}; background: ${v("code-bg")}; }
.codeblock-head { display: flex; justify-content: space-between; gap: ${v("md")}; padding: 7px 12px; border-bottom: 1px solid rgba(255,255,255,0.12); color: ${v("code-mute")}; font-size: ${tokens.size.xs}; font-family: ${v("font-mono")}; }
.codeblock pre { margin: 0; padding: 14px 16px; overflow-x: auto; color: ${v("code-ink")}; font-family: ${v("font-mono")}; font-size: ${tokens.size.mono}; line-height: 1.65; }
.codeblock pre code { background: none; border: 0; padding: 0; color: inherit; font-size: inherit; }

.callout { border: 1px solid ${v("hair")}; border-left: 3px solid ${v("teal")}; background: ${v("teal-sink")}; padding: ${v("sm")} ${v("md")}; margin: 0 0 ${v("lg")}; font-size: ${tokens.size.sm}; color: ${v("ink-soft")}; }
.callout.warn { border-left-color: ${v("warn")}; background: ${v("warn-sink")}; }
.callout strong { color: ${v("ink")}; }

.steps { list-style: none; margin: 0 0 ${v("lg")}; padding: 0; counter-reset: step; }
.steps li { position: relative; padding: 0 0 ${v("md")} 40px; counter-increment: step; }
.steps li::before { content: counter(step, decimal-leading-zero); position: absolute; left: 0; top: 0; font-family: ${v("font-mono")}; font-size: ${tokens.size.xs}; color: ${v("accent-text")}; border: 1px solid ${v("hair-strong")}; padding: 2px 5px; }
.steps strong { display: block; color: ${v("ink")}; }
.steps span { color: ${v("ink-soft")}; font-size: ${tokens.size.sm}; }

.cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: ${v("hair")}; border: 1px solid ${v("hair")}; margin: 0 0 ${v("lg")}; }
.cards > div { background: ${v("paper")}; padding: ${v("md")}; }
.cards h3 { font-size: ${tokens.size.base}; margin-bottom: 4px; }
.cards p { margin: 0; font-size: ${tokens.size.sm}; color: ${v("ink-soft")}; }
@media (max-width: 700px) { .cards { grid-template-columns: 1fr; } }

.badge { display: inline-block; font-size: ${tokens.size.xs}; font-family: ${v("font-mono")}; color: ${v("teal-text")}; background: ${v("teal-sink")}; border: 1px solid ${v("hair")}; padding: 1px 6px; }
.badge.muted { color: ${v("mute")}; background: ${v("paper-sink")}; }

/* ---------------------------------------------------------------- download */
.platform-tabs { display: flex; flex-wrap: wrap; gap: ${v("xs")}; margin-bottom: ${v("lg")}; }
.platform-tabs button { font: inherit; font-size: ${tokens.size.sm}; padding: 8px 14px; background: ${v("paper")}; border: 1px solid ${v("hair")}; color: ${v("ink-soft")}; cursor: pointer; border-radius: ${v("none")}; }
.platform-tabs button:hover { border-color: ${v("hair-strong")}; color: ${v("ink")}; }
.platform-tabs button[aria-selected="true"] { border-color: ${v("accent")}; color: ${v("accent-text")}; background: ${v("accent-sink")}; font-weight: 600; }
.release-panel { border: 1px solid ${v("hair")}; padding: ${v("lg")}; background: ${v("paper-alt")}; }
.release-panel h2 { font-size: ${tokens.size.lg}; margin-bottom: ${v("xs")}; }
.release-meta { display: flex; flex-wrap: wrap; gap: ${v("md")}; color: ${v("mute")}; font-size: ${tokens.size.sm}; margin-bottom: ${v("md")}; }
.release-actions { display: flex; flex-wrap: wrap; gap: ${v("sm")}; align-items: center; }
.release-note { color: ${v("mute")}; font-size: ${tokens.size.sm}; margin: ${v("md")} 0 0; }
.asset-list { list-style: none; margin: ${v("md")} 0 0; padding: 0; border-top: 1px solid ${v("hair")}; }
.asset-list li { display: flex; justify-content: space-between; gap: ${v("md")}; padding: 9px 0; border-bottom: 1px solid ${v("hair")}; font-size: ${tokens.size.sm}; font-family: ${v("font-mono")}; }
.asset-list a { overflow-wrap: anywhere; }

/* ---------------------------------------------------------------- footer */
.site-foot { border-top: 1px solid ${v("hair")}; background: ${v("paper-alt")}; padding: ${v("xl")} 0; }
.foot-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: ${v("lg")}; }
.foot-grid h2 { font-size: ${tokens.size.xs}; text-transform: uppercase; letter-spacing: 0.12em; color: ${v("mute")}; margin-bottom: ${v("xs")}; }
.foot-grid ul { list-style: none; margin: 0; padding: 0; }
.foot-grid li { margin: 5px 0; }
.foot-grid a { color: ${v("ink-soft")}; text-decoration: none; font-size: ${tokens.size.sm}; }
.foot-grid a:hover { color: ${v("ink")}; text-decoration: underline; }
.foot-bottom { display: flex; justify-content: space-between; gap: ${v("md")}; flex-wrap: wrap; margin-top: ${v("xl")}; padding-top: ${v("md")}; border-top: 1px solid ${v("hair")}; color: ${v("mute")}; font-size: ${tokens.size.xs}; }
@media (max-width: 800px) { .foot-grid { grid-template-columns: 1fr 1fr; } }

.not-found { padding: ${v("huge")} 0; text-align: center; }
.not-found h1 { font-size: ${tokens.size.hero}; }
`;
