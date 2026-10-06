/**
 * 设计系统组件：全站可复用的基础构件。只用语义工具类，不含任何字面量视觉参数。
 */
import { Link, type LinkProps } from "react-router";
import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/* ---------- 版式 ---------- */

type ContainerProps = ComponentPropsWithoutRef<"div"> & { width?: "prose" | "content" | "wide" };
export function Container({ width = "content", className, ...rest }: ContainerProps) {
  const w = width === "prose" ? "max-w-prose" : width === "wide" ? "max-w-wide" : "max-w-content";
  return <div className={cx("mx-auto w-full px-7 sm:px-8", w, className)} {...rest} />;
}

type SectionProps = ComponentPropsWithoutRef<"section"> & { tone?: "plain" | "elevated"; tight?: boolean };
/** 页面分节：统一纵向留白，矮窗口（横屏手机）自动压缩。 */
export function Section({ tone = "plain", tight, className, ...rest }: SectionProps) {
  return (
    <section
      className={cx(
        tight ? "py-10 sm:py-14 short:py-8" : "py-16 sm:py-24 short:py-10",
        tone === "elevated" && "bg-bg-elevated border-y border-border",
        className,
      )}
      {...rest}
    />
  );
}

export function Eyebrow({ className, ...rest }: ComponentPropsWithoutRef<"p">) {
  return <p className={cx("text-xs font-medium uppercase tracking-wide text-secondary-fg", className)} {...rest} />;
}

export function Heading({ as: Tag = "h2", size = "lg", className, ...rest }: ComponentPropsWithoutRef<"h2"> & { as?: "h1" | "h2" | "h3" | "h4"; size?: "xl" | "lg" | "md" | "sm" }) {
  const s = { xl: "text-4xl sm:text-5xl lg:text-6xl", lg: "text-3xl sm:text-4xl", md: "text-2xl sm:text-3xl", sm: "text-xl" }[size];
  return <Tag className={cx("font-semibold tracking-tight text-fg text-balance", s, className)} {...rest} />;
}

export function Lead({ className, ...rest }: ComponentPropsWithoutRef<"p">) {
  return <p className={cx("text-lg text-fg-muted text-pretty", className)} {...rest} />;
}

/* ---------- 按钮与链接 ---------- */

type Variant = "primary" | "secondary" | "ghost" | "accent";
type Size = "sm" | "md" | "lg";
const btnBase = "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors duration-(--ds-duration-fast) ease-standard focus-visible:shadow-ring disabled:pointer-events-none disabled:opacity-(--ds-opacity-disabled)";
const btnVariant: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:bg-fg-muted",
  secondary: "border border-border-strong bg-surface-hover text-fg hover:bg-secondary-soft",  // 浅浅的底色，让它在正文里看得出是按钮
  ghost: "text-fg-muted hover:text-fg hover:bg-surface-hover",
  // 琥珀只给「活着」的动作：下载 / 开始
  accent: "bg-accent text-accent-fg hover:bg-accent-hover shadow-glow",
};
const btnSize: Record<Size, string> = { sm: "h-8 px-3 text-sm", md: "h-10 px-4 text-sm", lg: "h-12 px-6 text-base" };

export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cx(btnBase, btnVariant[variant], btnSize[size], className);
}

export function Button({ variant, size, className, ...rest }: ComponentPropsWithoutRef<"button"> & { variant?: Variant; size?: Size }) {
  return <button className={buttonClass(variant, size, className)} {...rest} />;
}
export function ButtonLink({ variant, size, className, ...rest }: LinkProps & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}
export function ButtonAnchor({ variant, size, className, ...rest }: ComponentPropsWithoutRef<"a"> & { variant?: Variant; size?: Size }) {
  return <a className={buttonClass(variant, size, className)} {...rest} />;
}

export function TextLink({ className, ...rest }: LinkProps) {
  return <Link className={cx("text-link underline decoration-border-strong underline-offset-4 transition-colors duration-(--ds-duration-fast) hover:text-link-hover hover:decoration-fg", className)} {...rest} />;
}
export function ExternalLink({ className, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  return (
    <a className={cx("text-link underline decoration-border-strong underline-offset-4 transition-colors duration-(--ds-duration-fast) hover:text-link-hover hover:decoration-fg", className)} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  );
}

/* ---------- 容器类构件 ---------- */

export function Card({ className, interactive, ...rest }: ComponentPropsWithoutRef<"div"> & { interactive?: boolean }) {
  return (
    <div
      className={cx(
        "rounded-xl border border-border bg-surface p-6",
        interactive && "transition-colors duration-(--ds-duration-base) hover:border-border-strong hover:bg-surface-hover",
        className,
      )}
      {...rest}
    />
  );
}

type BadgeTone = "neutral" | "accent" | "secondary" | "success" | "warning" | "danger";
const badgeTone: Record<BadgeTone, string> = {
  neutral: "border-border text-fg-muted",
  accent: "border-accent-soft bg-accent-soft text-accent",
  secondary: "border-secondary-soft bg-secondary-soft text-secondary-fg",
  success: "border-border text-success",
  warning: "border-border text-warning",
  danger: "border-border text-danger",
};
export function Badge({ tone = "neutral", className, ...rest }: ComponentPropsWithoutRef<"span"> & { tone?: BadgeTone }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium", badgeTone[tone], className)} {...rest} />;
}

export function Kbd({ className, ...rest }: ComponentPropsWithoutRef<"kbd">) {
  return <kbd className={cx("rounded-sm border border-border bg-code-bg px-1.5 py-0.5 font-mono text-xs text-code-fg", className)} {...rest} />;
}

export function Divider({ className, ...rest }: ComponentPropsWithoutRef<"hr">) {
  return <hr className={cx("border-border", className)} {...rest} />;
}

/** 光团：品牌标志，与控制台首页的球同一套渲染（左上光源、明度偏移、高光点、光晕）。颜色来自设计系统的 orb-* 色标。 */
export function OrbMark({ size = 20, className }: { size?: number; className?: string }) {
  const id = useId();
  const g = `${id}g`, s = `${id}s`, h = `${id}h`;
  const v = (k: string) => `var(--ds-color-${k})`;
  // 高光点用 orb-hi（两套主题同色）：用正文色在浅色模式下会成黑点
  // 视口 100×100，球半径 r=24，光晕半径 2.2r；球体渐变以球心左上 0.38r 为光源、半径 1.38r；高光点在 -0.42r、半径 0.2r
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className={className}>
      <defs>
        <radialGradient id={g} cx="50" cy="50" r="52.8" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: v("orb-glow") }} /><stop offset="0.55" style={{ stopColor: v("orb-glow-mid") }} /><stop offset="1" style={{ stopColor: v("orb-glow-end") }} />
        </radialGradient>
        <radialGradient id={s} cx="40.9" cy="40.9" r="33.1" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: v("orb-hi") }} /><stop offset="0.25" style={{ stopColor: v("orb-mid") }} /><stop offset="0.6" style={{ stopColor: v("orb") }} /><stop offset="1" style={{ stopColor: v("orb-rim") }} />
        </radialGradient>
        <radialGradient id={h} cx="39.9" cy="39.9" r="4.8" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: v("orb-hi"), stopOpacity: 0.95 }} /><stop offset="1" style={{ stopColor: v("orb-hi"), stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="52.8" fill={`url(#${g})`} />
      <circle cx="50" cy="50" r="24" fill={`url(#${s})`} />
      <circle cx="39.9" cy="39.9" r="4.8" fill={`url(#${h})`} />
    </svg>
  );
}

/** 状态灯：唯一允许「亮」的小元素。alive 时呼吸。 */
export function StatusDot({ alive, className }: { alive?: boolean; className?: string }) {
  return (
    <span className={cx("relative inline-flex size-2.5 shrink-0", className)} aria-hidden>
      <span className={cx("absolute inset-0 rounded-full", alive ? "bg-accent shadow-glow animate-breath motion-reduce:animate-none" : "bg-fg-subtle")} />
    </span>
  );
}

/* ---------- 动效 ---------- */

/** 进场：进入视口时淡入 + 上移。预渲染 HTML 默认可见（无 JS / 爬虫也能读）；水合后只对尚在视口外的元素隐藏并等待进入。 */
export function Reveal({ children, className, delay = 0, as: Tag = "div" }: { children: ReactNode; className?: string; delay?: 0 | 1 | 2 | 3; as?: "div" | "li" | "section" | "article" }) {
  const ref = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<"static" | "hidden" | "shown">("static");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return; // 首屏内：保持可见，不动
    setState("hidden");
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setState("shown"); io.disconnect(); } }, { rootMargin: "0px 0px -10% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const delayClass = ["", "[animation-delay:var(--ds-duration-fast)]", "[animation-delay:var(--ds-duration-base)]", "[animation-delay:var(--ds-duration-slow)]"][delay]; // ds-allow：仅引用变量
  return (
    <Tag ref={ref as never} className={cx(state === "hidden" && "opacity-0", state === "shown" && cx("animate-reveal", delayClass), className)}>
      {children}
    </Tag>
  );
}

/** 呼吸光斑：全站唯一持续动的东西。有机形状、慢、幅度小。 */
export function Breath({ className, size = "lg" }: { className?: string; size?: "sm" | "md" | "lg" }) {
  const s = { sm: "size-24", md: "size-48", lg: "size-[28rem]" }[size]; // ds-allow：尺寸不是视觉参数
  return (
    <div aria-hidden className={cx("pointer-events-none absolute", s, className)}>
      <div className="absolute inset-0 rounded-full bg-accent-glow blur-halo opacity-(--ds-opacity-halo) animate-breath motion-reduce:animate-none" />
      <div className="absolute inset-[18%] rounded-[46%_54%_52%_48%/55%_45%_55%_45%] bg-accent-glow-faint blur-glass animate-breath [animation-delay:calc(var(--ds-duration-breath)/-3)] motion-reduce:animate-none" /> {/* ds-allow：有机形状的圆角比例 */}
    </div>
  );
}
