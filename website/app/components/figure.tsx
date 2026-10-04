/**
 * 示意图公共件：Frame（容器，窄屏时文字按比例放大）、T（文字）、Lamp（呼吸的琥珀点）。
 * 只用设计系统语义类，不含字面量视觉参数。
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { cx } from "~/design-system/components";

/** 图的设计宽度。容器比它窄（手机）时 SVG 整体缩小，文字按比例放大补偿。 */
export const DESIGN_W = 480;
const TextScale = createContext(1);
/** 示意图文字整体放大系数（随「全站文字加大加粗」一起调） */
const TEXT_BOOST = 1.15;

export function Frame({ children, label, height = 320, bare }: { children: React.ReactNode; label: string; height?: number; bare?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [k, setK] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { const w = e.contentRect.width; setK(w > 0 && w < DESIGN_W ? Math.min(1.5, DESIGN_W / w) : 1); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <figure ref={ref} className={bare ? "" : "rounded-2xl border border-border bg-surface p-4 sm:p-6"}>
      <TextScale.Provider value={k}>
        <svg viewBox={`0 0 ${DESIGN_W} ${height}`} role="img" aria-label={label} className="block w-full font-sans">{children}</svg>
      </TextScale.Provider>
    </figure>
  );
}

export const T = ({ x, y, children, className, anchor = "start", size = 13 }: { x: number; y: number; children: React.ReactNode; className?: string; anchor?: "start" | "middle" | "end"; size?: number }) => {
  const k = useContext(TextScale);
  return <text x={x} y={y} textAnchor={anchor} fontSize={Math.round(size * k * TEXT_BOOST * 10) / 10} className={cx(!/\bfill-/.test(className ?? "") && "fill-fg", "font-medium", className)}>{children}</text>;
};

/** 呼吸的琥珀点（SVG 内用 transform-box 让缩放围绕自身中心） */
export const Lamp = ({ cx: x, cy, r = 5, delay = 0 }: { cx: number; cy: number; r?: number; delay?: 0 | 1 | 2 | 3 }) => (
  <circle cx={x} cy={cy} r={r} className={cx("fill-accent animate-breath motion-reduce:animate-none origin-center [transform-box:fill-box]", ["", "[animation-delay:-1s]", "[animation-delay:-2s]", "[animation-delay:-3.5s]"][delay])} /> /* ds-allow：错开相位 */
);

export type CompareLabels = { rows: readonly { name: string; note: string }[]; axis: readonly string[]; call: string };

/** 三条 24 小时带子：Codex / Claude Code（你叫它才动）· Hermes / OpenClaw（每 30 分钟 heartbeat）· Quetzal（没有定时器）。
 *  每行的名字与说明上下两行（都左对齐），不放在同一行：窄屏时文字按比例放大，同一行放不下会互相压住。 */
export function WakeCompare({ t, bare }: { t: CompareLabels; bare?: boolean }) {
  const x0 = 28, x1 = 452, rows = [96, 196, 296];
  const px = (h: number) => x0 + ((x1 - x0) * h) / 24;
  const calls = [8.9, 14.6, 20.8];
  const wakes = [7.9, 8.6, 10.2, 10.9, 11.3, 13.4, 14.1, 14.5, 15.2, 15.6, 16.1, 16.9, 17.8, 19.3, 20.7, 22.4];
  const alert = Array.from({ length: 49 }, (_, i) => { const h = i / 2; const c = 0.5 + 0.5 * Math.cos((2 * Math.PI * (h - 16)) / 24); return `${i ? "L" : "M"}${px(h).toFixed(1)},${(rows[2] + 14 - 44 * c).toFixed(1)}`; }).join(" ");
  const head = (i: number, strong?: boolean) => (
    <>
      <T x={x0} y={rows[i] - 52} className={strong ? "fill-fg font-semibold" : "fill-fg-muted"} size={13}>{t.rows[i].name}</T>
      <T x={x0} y={rows[i] - 32} className="fill-fg-subtle" size={11}>{t.rows[i].note}</T>
      <line x1={x0} x2={x1} y1={rows[i]} y2={rows[i]} className="stroke-border" strokeWidth="2" />
    </>
  );
  return (
    <Frame label={t.rows.map((r) => r.name).join(" · ")} height={330} bare={bare}>
      {head(0)}
      {calls.map((h) => (
        <g key={h}>
          <circle cx={px(h)} cy={rows[0]} r="4.5" className="fill-fg-subtle" />
          <T x={px(h)} y={rows[0] - 10} className="fill-fg-subtle" size={10.5} anchor="middle">{t.call}</T>
        </g>
      ))}
      {head(1)}
      {Array.from({ length: 49 }, (_, i) => <rect key={i} x={px(i / 2) - 1} y={rows[1] - 7} width="2" height="14" className="fill-fg-subtle" />)}
      {head(2, true)}
      <rect x={px(0)} y={rows[2] - 9} width={px(7.8) - px(0)} height="18" rx="3" className="fill-chart-fill" />
      <rect x={px(22.6)} y={rows[2] - 9} width={px(24) - px(22.6)} height="18" rx="3" className="fill-chart-fill" />
      <path d={alert} fill="none" className="stroke-chart-line" strokeWidth="1.2" strokeDasharray="4 4" />
      {wakes.map((h, i) => <Lamp key={h} cx={px(h)} cy={rows[2]} r={4.5} delay={(i % 4) as 0 | 1 | 2 | 3} />)}
      {t.axis.map((a, i) => <T key={a} x={px(i * 6)} y={323} className="fill-fg-subtle" size={11} anchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}>{a}</T>)}
    </Frame>
  );
}
