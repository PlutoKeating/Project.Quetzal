/**
 * Windler 官网设计系统：全站唯一的视觉参数来源。
 *
 * 规则：页面与组件里禁止出现任何字面量的色值、圆角、阴影、光效、透明度、模糊、时长。
 * 一切都从这里取：构建前由 scripts/gen-tokens.ts 生成 tokens.generated.css（CSS 变量 + Tailwind @theme），
 * 页面只用语义化的工具类（bg-surface、text-fg-muted、rounded-lg、shadow-glow …）。
 * scripts/lint-tokens.ts 会在构建前扫描 app/（本目录除外），发现硬编码即失败。
 *
 * 初稿基调：深色优先、暖色点缀——这是在陪伴一个生命，不是一块运维面板。浅色随系统偏好切换。
 */

export type ColorScheme = "dark" | "light";

/** 语义色：两套取值，键必须完全一致。 */
const palette = {
  dark: {
    bg: "#0e0d11",
    "bg-elevated": "#141319",
    surface: "#1a1920",
    "surface-hover": "#211f28",
    "surface-glass": "rgb(26 25 32 / 0.6)",
    border: "rgb(255 255 255 / 0.08)",
    "border-strong": "rgb(255 255 255 / 0.16)",
    fg: "#f3efe9",
    "fg-muted": "#b2aba3",
    "fg-subtle": "#7c766f",
    accent: "#f0a35e",
    "accent-hover": "#f6b878",
    "accent-fg": "#1a120a",
    "accent-soft": "rgb(240 163 94 / 0.14)",
    "accent-glow": "rgb(240 163 94 / 0.35)",
    secondary: "#8fb3c9",
    "secondary-soft": "rgb(143 179 201 / 0.14)",
    success: "#7fc69a",
    warning: "#e6c35c",
    danger: "#e07a7a",
    overlay: "rgb(0 0 0 / 0.6)",
    "code-bg": "#121117",
    selection: "rgb(240 163 94 / 0.3)",
  },
  light: {
    bg: "#faf7f2",
    "bg-elevated": "#ffffff",
    surface: "#ffffff",
    "surface-hover": "#f4efe7",
    "surface-glass": "rgb(255 255 255 / 0.7)",
    border: "rgb(30 25 20 / 0.1)",
    "border-strong": "rgb(30 25 20 / 0.2)",
    fg: "#1d1a17",
    "fg-muted": "#5c554e",
    "fg-subtle": "#8a827a",
    accent: "#c9732c",
    "accent-hover": "#b4631f",
    "accent-fg": "#fff8f0",
    "accent-soft": "rgb(201 115 44 / 0.12)",
    "accent-glow": "rgb(201 115 44 / 0.25)",
    secondary: "#3f6f8c",
    "secondary-soft": "rgb(63 111 140 / 0.12)",
    success: "#2f8a55",
    warning: "#a8821a",
    danger: "#b84a4a",
    overlay: "rgb(20 15 10 / 0.4)",
    "code-bg": "#f1ece4",
    selection: "rgb(201 115 44 / 0.25)",
  },
} as const satisfies Record<ColorScheme, Record<string, string>>;

export type ColorToken = keyof (typeof palette)["dark"];

export const designSystem = {
  colors: palette,

  /** 元素外形 */
  radius: {
    xs: "0.25rem",
    sm: "0.375rem",
    md: "0.625rem",
    lg: "0.875rem",
    xl: "1.25rem",
    "2xl": "1.75rem",
    full: "9999px",
  },
  borderWidth: { hairline: "1px", thick: "2px" },

  /** 阴影与光效（引用色变量，随明暗切换） */
  shadow: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.2)",
    md: "0 6px 20px -6px rgb(0 0 0 / 0.35)",
    lg: "0 20px 50px -20px rgb(0 0 0 / 0.5)",
    glow: "0 0 0 1px var(--ds-color-accent-soft), 0 0 40px -8px var(--ds-color-accent-glow)",
    "glow-strong": "0 0 0 1px var(--ds-color-accent-soft), 0 0 80px -10px var(--ds-color-accent-glow)",
    ring: "0 0 0 3px var(--ds-color-accent-soft)",
  },
  blur: { glass: "16px", halo: "80px" },

  /** 透明度（用于 opacity-(--ds-opacity-*)） */
  opacity: {
    disabled: "0.45",
    muted: "0.7",
    hover: "0.85",
    halo: "0.5",
    "halo-light": "0.25",
  },

  /** 动效 */
  motion: {
    duration: { fast: "120ms", base: "200ms", slow: "400ms", reveal: "700ms" },
    ease: {
      standard: "cubic-bezier(0.2, 0, 0, 1)",
      emphasized: "cubic-bezier(0.3, 0, 0, 1)",
      spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    },
  },

  /** 字体 */
  font: {
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans", sans-serif',
    serif: '"Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif CJK SC", Georgia, serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace',
  },
  /** 字号（rem）与行高 */
  text: {
    xs: ["0.75rem", "1.1rem"],
    sm: ["0.875rem", "1.35rem"],
    base: ["1rem", "1.6rem"],
    lg: ["1.125rem", "1.75rem"],
    xl: ["1.25rem", "1.8rem"],
    "2xl": ["1.5rem", "2rem"],
    "3xl": ["1.875rem", "2.3rem"],
    "4xl": ["2.5rem", "2.9rem"],
    "5xl": ["3.25rem", "3.5rem"],
    "6xl": ["4.25rem", "4.4rem"],
  },

  /** 版式宽度与断点 */
  container: { prose: "44rem", content: "72rem", wide: "88rem" },
  breakpoint: { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" },
  /** 高度断点：横屏手机 / 小窗口（配合 short: 变体） */
  shortHeight: "36rem",
  /** 顶栏高度 */
  headerHeight: "3.75rem",
} as const;

export type DesignSystem = typeof designSystem;
