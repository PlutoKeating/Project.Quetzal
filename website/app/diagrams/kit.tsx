// 图的画法（packages/design-system/guidelines/diagrams.md）的原语。
// 图是直接画在黑色画布上的工程图：透明背景、没有外框、上下各一条通栏发丝线，
// 颜色只有冰蓝（已验证、完成、结果）与琥珀（需要人、检查点），各出现一到三处。
import type { ReactNode } from "react";

/** 墨色与两个信号色：一律引用设计系统的 token。 */
export const ink = {
  white: "var(--qz-ink)",
  bright: "var(--qz-ink-bright)",
  support: "var(--qz-ink-support)",
  subtle: "var(--qz-ink-subtle)",
  secondary: "var(--qz-ink-secondary)",
  void: "var(--qz-void)",
  ice: "var(--qz-ice)",
  amber: "var(--qz-amber)",
} as const;

/** 结构线。edge 与 drift 是 diagrams.md 规定、而设计系统尚未给出 token 的两个值。 */
export const line = {
  edge: "rgba(255,255,255,0.08)",
  ghost: "var(--qz-line-ghost)",
  mark: "var(--qz-line-mark)",
  link: "var(--qz-border-strong)",
  node: "var(--qz-line-control)",
  drift: "#737373",
} as const;

const font = { sans: "var(--qz-font-sans)", mono: "var(--qz-font-mono)" } as const;

/** 画布：内联 SVG，上下边界各一条发丝线（画在半像素上）。id 用来给辉光滤镜起不重复的名字。 */
export function Canvas({ id, w, h, label, children }: { id: string; w: number; h: number; label: string; children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${w} ${h}`} fill="none" xmlns="http://www.w3.org/2000/svg" className="qz-diagram" role="img" aria-label={label}>
      <defs>
        <filter id={`${id}-glow`} filterUnits="userSpaceOnUse" x="0" y="0" width={w} height={h}>
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <line x1="0" y1="0.5" x2={w} y2="0.5" stroke={line.edge} />
      <line x1="0" y1={h - 0.5} x2={w} y2={h - 0.5} stroke={line.edge} />
      {children}
    </svg>
  );
}

/** 分区横线 */
export function Rule({ y, x1, x2 }: { y: number; x1: number; x2: number }) {
  return <line x1={x1} y1={y} x2={x2} y2={y} stroke={line.edge} />;
}

/** 幽灵栅格竖线 */
export function Ghost({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return <line x1={x} y1={y1} x2={x} y2={y2} stroke={line.ghost} />;
}

/** 栅格交点的 8px 十字准星 */
export function Cross({ x, y }: { x: number; y: number }) {
  return <path d={`M${x - 4} ${y}H${x + 4} M${x} ${y - 4}V${y + 4}`} stroke={line.mark} strokeWidth="1" />;
}

/** 正确的路径：白色实线，下面垫一层冰蓝辉光（图里唯一允许的辉光）。 */
export function Trace({ id, d }: { id: string; d: string }) {
  return (
    <>
      <path d={d} stroke={ink.ice} strokeOpacity="0.45" strokeWidth="4" filter={`url(#${id}-glow)`} />
      <path d={d} stroke={ink.white} strokeWidth="1.8" />
    </>
  );
}

/** 次级连接线；dashed 表示尚未发生。 */
export function Wire({ d, dashed }: { d: string; dashed?: boolean }) {
  return <path d={d} stroke={ink.white} strokeOpacity="0.24" strokeWidth="1.4" strokeDasharray={dashed ? "4 4" : undefined} />;
}

/** 偏离的路径：灰色虚线 */
export function Drift({ d }: { d: string }) {
  return <path d={d} stroke={line.drift} strokeWidth="1.6" strokeDasharray="4 5" />;
}

export type Mark = "pass" | "end" | "neutral" | "amber" | "fail" | "later";

/** 节点：途经（空心）、终点（实心 + 冰蓝细环）、中性、琥珀检查点、未达成（琥珀 ×）、尚未发生。 */
export function Node({ x, y, mark }: { x: number; y: number; mark: Mark }) {
  switch (mark) {
    case "pass":
      return <circle cx={x} cy={y} r="5" fill={ink.void} stroke={ink.white} strokeWidth="1.8" />;
    case "end":
      return (
        <>
          <circle cx={x} cy={y} r="6" fill={ink.white} />
          <circle cx={x} cy={y} r="11" stroke={ink.ice} strokeOpacity="0.45" strokeWidth="1" />
        </>
      );
    case "amber":
      return <circle cx={x} cy={y} r="4.5" fill={ink.amber} />;
    case "fail":
      return <path d={`M${x - 6} ${y - 6}L${x + 6} ${y + 6} M${x + 6} ${y - 6}L${x - 6} ${y + 6}`} stroke={ink.amber} strokeWidth="1.8" />;
    case "later":
      return <circle cx={x} cy={y} r="4" fill={ink.support} />;
    case "neutral":
      return <circle cx={x} cy={y} r="4" fill={ink.secondary} />;
  }
}

type TextProps = {
  x: number;
  y: number;
  children: ReactNode;
  size?: number;
  weight?: 400 | 500;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  mono?: boolean;
};

/** 图里的文字：跟随页面字体。 */
export function T({ x, y, children, size = 13.5, weight, fill = ink.support, anchor, mono }: TextProps) {
  return (
    <text x={x} y={y} fill={fill} fontFamily={mono ? font.mono : font.sans} fontSize={size} fontWeight={weight} textAnchor={anchor}>
      {children}
    </text>
  );
}

/** 节点框：描边 0.14 白；active 的那个顶边换成 1.8px 冰蓝。 */
export function Box({ x, y, w, h, active, solid }: { x: number; y: number; w: number; h: number; active?: boolean; solid?: boolean }) {
  return (
    <>
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} stroke={line.node} fill={solid ? ink.void : undefined} />
      {active ? <line x1={x} y1={y + 0.5} x2={x + w} y2={y + 0.5} stroke={ink.ice} strokeWidth="1.8" /> : null}
    </>
  );
}

/** 线框里的「文字块」：白色不同透明度的矩形。 */
export function Bar({ x, y, w, h = 5, o }: { x: number; y: number; w: number; h?: number; o: number }) {
  return <rect x={x} y={y} width={w} height={h} fill={ink.white} fillOpacity={o} />;
}

/** 四角的冰蓝角标：框出已验证的区域。 */
export function Corners({ x, y, w, h, tone = "ice" }: { x: number; y: number; w: number; h: number; tone?: "ice" | "amber" }) {
  const r = x + w;
  const b = y + h;
  return (
    <path
      d={`M${x} ${y + 10}V${y}H${x + 10} M${r - 10} ${y}H${r}V${y + 10} M${x} ${b - 10}V${b}H${x + 10} M${r - 10} ${b}H${r}V${b - 10}`}
      stroke={tone === "ice" ? ink.ice : ink.amber}
      strokeWidth="1.2"
    />
  );
}
