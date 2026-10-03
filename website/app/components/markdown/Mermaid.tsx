import { useEffect, useId, useRef, useState } from "react";
import { useMessages } from "~/i18n/core";
import { mdMessages } from "./i18n";

type MermaidModule = typeof import("mermaid").default;
let mermaidPromise: Promise<MermaidModule> | null = null;
const loadMermaid = () => (mermaidPromise ??= import("mermaid").then((m) => m.default));

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

/** 预渲染时输出源码占位；客户端挂载后按需加载 mermaid 渲染 SVG；主题变化时重渲染；失败则显示源码。 */
export function Mermaid({ code }: { code: string }) {
  const t = useMessages(mdMessages);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const obs = new MutationObserver(() => setTick((n) => n + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => setTick((n) => n + 1);
    mq.addEventListener("change", onMq);
    return () => { obs.disconnect(); mq.removeEventListener("change", onMq); };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVariables() });
        const { svg } = await mermaid.render(`m${id}${tick}`, code);
        if (alive && ref.current) { ref.current.innerHTML = svg; setState("ok"); }
      } catch {
        if (alive) setState("error");
      }
    })();
    return () => { alive = false; };
  }, [code, id, tick]);

  return (
    <figure className="md-mermaid my-5 overflow-x-auto rounded-lg border border-border bg-surface p-4">
      {state !== "error" && <div ref={ref} className="flex justify-center [&_svg]:max-w-full" aria-busy={state === "idle"} />}
      {state === "idle" && <p className="text-center text-xs text-fg-subtle">{t.mermaidLoading}</p>}
      {state === "error" && (
        <>
          <p className="mb-2 text-xs text-warning">{t.mermaidFailed}</p>
          <pre className="overflow-x-auto text-xs text-code-fg"><code>{code}</code></pre>
        </>
      )}
    </figure>
  );
}
