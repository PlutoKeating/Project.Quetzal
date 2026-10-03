import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useMessages } from "~/i18n/core";
import { cx } from "~/design-system/components";
import { mdMessages } from "./i18n";
import { Lightbox, type Natural } from "./Lightbox";

type MermaidModule = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidModule> | null = null;
const loadMermaid = () => (mermaidPromise ??= import("mermaid").then((m) => m.default));

/** 容器窄于此宽度视为「窄屏」：横向流程图改为纵向。 */
const NARROW = 640;
/** 图比容器宽时，缩到不低于这个比例仍可读，就整体缩放；否则按原始尺寸横向滚动。 */
const MIN_FIT = 0.72;

/** 读取设计系统色（经浮点层解析为 rgb），转成 mermaid 能吃的 #rrggbb。 */
function dsColor(name: string, fallback: string): string {
  const el = document.createElement("span");
  el.style.color = `var(--ds-color-${name})`;
  el.style.display = "none";
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c);
  if (!m) return fallback;
  return "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

function themeVariables() {
  const bg = dsColor("surface", dsColor("bg", "#000000")); // ds-allow：仅作读取失败时的兜底，不会显示
  const fg = dsColor("fg", "#ffffff"); // ds-allow
  const muted = dsColor("fg-muted", fg);
  const border = dsColor("border-strong", muted);
  const accent = dsColor("accent", fg);
  const secondary = dsColor("secondary", muted);
  const soft = dsColor("surface-hover", bg);
  return {
    darkMode: document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches),
    fontSize: "17px",
    background: bg, mainBkg: soft, primaryColor: soft, primaryTextColor: fg, primaryBorderColor: border,
    secondaryColor: soft, secondaryTextColor: fg, secondaryBorderColor: border, tertiaryColor: bg, tertiaryTextColor: fg, tertiaryBorderColor: border,
    lineColor: muted, textColor: fg, nodeTextColor: fg, titleColor: fg, edgeLabelBackground: bg, clusterBkg: bg, clusterBorder: border,
    noteBkgColor: soft, noteTextColor: fg, noteBorderColor: border, actorBkg: soft, actorBorder: border, actorTextColor: fg, signalColor: muted, signalTextColor: fg,
    labelBoxBkgColor: soft, labelBoxBorderColor: border, labelTextColor: fg, loopTextColor: fg, activationBkgColor: soft, activationBorderColor: accent,
    sectionBkgColor: soft, sectionBkgColor2: bg, altSectionBkgColor: bg, taskBkgColor: secondary, taskBorderColor: border, taskTextColor: fg, taskTextLightColor: fg, taskTextDarkColor: fg,
    activeTaskBkgColor: accent, activeTaskBorderColor: accent, doneTaskBkgColor: soft, doneTaskBorderColor: border, critBkgColor: accent, critBorderColor: accent, todayLineColor: accent,
    gridColor: border, pie1: accent, pie2: secondary, pie3: muted, pie4: soft, pieTitleTextColor: fg, pieSectionTextColor: fg, pieLegendTextColor: fg, pieStrokeColor: border, pieOuterStrokeColor: border,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--ds-font-sans") || "sans-serif",
  };
}

/** 窄屏时把横向流程图（LR / RL）改为纵向（TB），包括子图里的 direction。 */
export function adaptDirection(code: string, narrow: boolean): string {
  if (!narrow) return code;
  return code.replace(/^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/m, "$1TB").replace(/^(\s*direction\s+)(LR|RL)\b/gm, "$1TB");
}

/** 读取 mermaid 输出 SVG 的原始尺寸。 */
function svgSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0) return { w: vb[2], h: vb[3] };
  const bb = svg.getBBox();
  return { w: bb.width || 600, h: bb.height || 400 };
}

/** 按容器宽度决定：原尺寸居中 / 整体缩放到容器宽 / 原尺寸横向滚动。返回是否溢出（需要滚动）。 */
function layoutSvg(svg: SVGSVGElement, containerWidth: number): boolean {
  const { w, h } = svgSize(svg);
  svg.style.maxWidth = "none";
  if (w <= containerWidth || containerWidth / w >= MIN_FIT) {
    const width = Math.min(w, containerWidth);
    svg.style.width = `${width}px`;
    svg.style.height = `${(h * width) / w}px`;
    return false;
  }
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;
  return true;
}

/** 预渲染时输出占位；客户端挂载后按需加载 mermaid 渲染 SVG。窄屏改纵向、宽图可滚动或全屏放大、主题变化时重渲染、失败显示源码。 */
export function Mermaid({ code }: { code: string }) {
  const t = useMessages(mdMessages);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const figRef = useRef<HTMLElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  const [tick, setTick] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [svgMarkup, setSvgMarkup] = useState("");
  const [natural, setNatural] = useState<Natural | null>(null);
  const [open, setOpen] = useState(false);

  // 主题变化 → 重渲染
  useEffect(() => {
    const obs = new MutationObserver(() => setTick((n) => n + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => setTick((n) => n + 1);
    mq.addEventListener("change", onMq);
    return () => { obs.disconnect(); mq.removeEventListener("change", onMq); };
  }, []);

  // 容器宽度：决定窄屏（重渲染）与缩放（不重渲染）
  const relayout = useCallback(() => {
    const fig = figRef.current;
    const svg = ref.current?.querySelector("svg");
    if (!fig) return;
    const cw = fig.clientWidth - 32; // 内边距
    setNarrow(cw < NARROW);
    if (svg) setOverflow(layoutSvg(svg, cw));
  }, []);
  useEffect(() => {
    const fig = figRef.current;
    if (!fig || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => relayout());
    ro.observe(fig);
    relayout();
    return () => ro.disconnect();
  }, [relayout]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        const common = { useMaxWidth: false };
        mermaid.initialize({
          startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVariables(),
          flowchart: { ...common, htmlLabels: true, nodeSpacing: 36, rankSpacing: 44, padding: 12, curve: "basis", wrappingWidth: 240 },
          sequence: { ...common, wrap: true, width: 140, actorMargin: 20, messageMargin: 28, boxMargin: 8, mirrorActors: false },
          gantt: { ...common, fontSize: 14, barHeight: 24 }, mindmap: { ...common, padding: 12 }, state: common, class: common, journey: common, timeline: common, pie: common, er: common, gitGraph: common,
        });
        const { svg } = await mermaid.render(`m${id}${tick}`, adaptDirection(code, narrow));
        if (!alive || !ref.current) return;
        ref.current.innerHTML = svg;
        setSvgMarkup(svg);
        const el = ref.current.querySelector("svg");
        if (el) setNatural(svgSize(el));
        setState("ok");
        relayout();
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => { alive = false; };
  }, [code, id, tick, narrow, relayout]);

  return (
    <figure ref={figRef} className="md-mermaid my-5 rounded-lg border border-border bg-surface p-4">
      {state !== "error" && (
        <div className={cx("overflow-x-auto", overflow ? "" : "flex justify-center")} aria-busy={state === "idle"}>
          <div ref={ref} className={cx(overflow ? "w-max" : "", "[&_svg]:block")} />
        </div>
      )}
      {state === "idle" && <p className="text-center text-xs text-fg-subtle">{t.mermaidLoading}</p>}
      {state === "ok" && (
        <figcaption className="mt-3 flex items-center justify-between gap-3 text-xs text-fg-subtle">
          <span>{overflow ? t.mermaidScroll : ""}</span>
          <button type="button" onClick={() => setOpen(true)} className="rounded-md border border-border px-2 py-1 text-fg-muted transition-colors duration-(--ds-duration-fast) hover:bg-surface-hover hover:text-fg">
            {t.mermaidZoom}
          </button>
        </figcaption>
      )}
      {state === "error" && (
        <>
          <p className="mb-2 text-xs text-warning">{t.mermaidFailed}</p>
          <pre className="overflow-x-auto text-xs text-code-fg"><code>{code}</code></pre>
        </>
      )}
      {open && natural && (
        <Lightbox natural={natural} onClose={() => setOpen(false)}>
          {(size) => <div style={size} className="[&_svg]:block [&_svg]:h-full! [&_svg]:w-full! [&_svg]:max-w-none!" dangerouslySetInnerHTML={{ __html: svgMarkup }} />}
        </Lightbox>
      )}
    </figure>
  );
}
