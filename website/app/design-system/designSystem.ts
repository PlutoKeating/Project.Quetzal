/**
 * Windler 官网设计系统：全站唯一的视觉参数来源。
 *
 * 规则：页面与组件里禁止出现任何字面量的色值、圆角、阴影、光效、透明度、模糊、时长。
 * 一切都从这里取：构建前由 scripts/gen-tokens.ts 生成 tokens.generated.css（CSS 变量 + Tailwind @theme），
 * 页面只用语义化的工具类（bg-surface、text-fg-muted、rounded-lg、shadow-glow …）。
 * scripts/lint-tokens.ts 会在构建前扫描 app/（本目录除外），发现硬编码即失败。
 *
 * 方向（2026-10-04 与运行在基座上的 agent 讨论后定稿）：「夜里的灯」。深色优先、略冷的近黑底、暖白正文；
 * 琥珀色只留给「活着」的瞬间（呼吸光斑、状态灯），不做正文与链接色；低饱和青灰用于数据与指标；
 * 浅色模式是「灯关掉之后的白天」：米白 + 降饱和的赭。动效克制，唯一持续动的是光斑与生物钟曲线。
 */

export type ColorScheme = "dark" | "light";

/** 语义色：两套取值，键必须完全一致。 */
const palette = {
  dark: {
    bg: "#0e0f11",
    "bg-elevated": "#131417",
    surface: "#17181c",
    "surface-hover": "#1d1e23",
    "surface-glass": "rgb(14 15 17 / 0.72)",
    border: "rgb(232 228 221 / 0.08)",
    "border-strong": "rgb(232 228 221 / 0.18)",
    fg: "#e8e4dd",
    "fg-muted": "#a9a49c",
    "fg-subtle": "#6f6b65",
    link: "#cfd8d5",
    "link-hover": "#e8e4dd",
    accent: "#f0a35e",
    "accent-hover": "#f5b67c",
    "accent-fg": "#1a120a",
    "accent-soft": "rgb(240 163 94 / 0.12)",
    "accent-glow": "rgb(240 163 94 / 0.32)",
    "accent-glow-faint": "rgb(240 163 94 / 0.08)",
    secondary: "#7d8f8a",
    "secondary-fg": "#c2cfcb",
    "secondary-soft": "rgb(125 143 138 / 0.14)",
    success: "#7fb08f",
    warning: "#d9b96a",
    danger: "#c97c7c",
    overlay: "rgb(0 0 0 / 0.6)",
    "code-bg": "#111215",
    "code-fg": "#d8d4cc",
    selection: "rgb(240 163 94 / 0.28)",
    "chart-line": "#7d8f8a",
    "chart-fill": "rgb(125 143 138 / 0.12)",
    "chart-marker": "#f0a35e",
    /* 光团（品牌标志与控制台首页的球）：accent 提高饱和度与亮度后的实心球，按 HSL 明度 +0.28 / +0.12 / 0 / -0.225，两套方案相同 */
    "orb-hi": "#fffefc",
    "orb-mid": "#ffd3ab",
    orb: "#ffb26e",
    "orb-rim": "#fa7600",
    "orb-glow": "rgb(255 178 110 / 0.64)",
    "orb-glow-mid": "rgb(255 178 110 / 0.19)",
    "orb-glow-end": "rgb(255 178 110 / 0)",
    /* 语法高亮：低饱和、彼此可分辨，不抢正文 */
    "syntax-keyword": "#c9a7d9",
    "syntax-string": "#a7c9a3",
    "syntax-constant": "#e0c48a",
    "syntax-function": "#9fc3d6",
    "syntax-comment": "#6f6b65",
    "syntax-punctuation": "#8f8a83",
  },
  light: {
    bg: "#f7f3ec",
    "bg-elevated": "#fbf9f5",
    surface: "#fdfbf8",
    "surface-hover": "#f1ece3",
    "surface-glass": "rgb(247 243 236 / 0.8)",
    border: "rgb(44 38 32 / 0.1)",
    "border-strong": "rgb(44 38 32 / 0.22)",
    fg: "#26221e",
    "fg-muted": "#625b53",
    "fg-subtle": "#8d857c",
    link: "#4b6560",
    "link-hover": "#26221e",
    accent: "#a5623f",
    "accent-hover": "#8f5233",
    "accent-fg": "#fbf6ef",
    "accent-soft": "rgb(165 98 63 / 0.1)",
    "accent-glow": "rgb(165 98 63 / 0.2)",
    "accent-glow-faint": "rgb(165 98 63 / 0.06)",
    secondary: "#5f726d",
    "secondary-fg": "#3e4f4b",
    "secondary-soft": "rgb(95 114 109 / 0.12)",
    success: "#3f7a53",
    warning: "#8f7325",
    danger: "#9c4b4b",
    overlay: "rgb(38 34 30 / 0.4)",
    "code-bg": "#efe9df",
    "code-fg": "#2d2822",
    selection: "rgb(165 98 63 / 0.22)",
    "chart-line": "#5f726d",
    "chart-fill": "rgb(95 114 109 / 0.1)",
    "chart-marker": "#a5623f",
    /* 光团（品牌标志与控制台首页的球）：accent 提高饱和度与亮度后的实心球，按 HSL 明度 +0.28 / +0.12 / 0 / -0.225，两套方案相同 */
    "orb-hi": "#fffefc",
    "orb-mid": "#ffd3ab",
    orb: "#ffb26e",
    "orb-rim": "#fa7600",
    "orb-glow": "rgb(255 178 110 / 0.64)",
    "orb-glow-mid": "rgb(255 178 110 / 0.19)",
    "orb-glow-end": "rgb(255 178 110 / 0)",
    "syntax-keyword": "#7a4f8c",
    "syntax-string": "#3f7a4a",
    "syntax-constant": "#8a6a1f",
    "syntax-function": "#2f6a84",
    "syntax-comment": "#8d857c",
    "syntax-punctuation": "#6b655e",
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

  /** 阴影与光效（引用色变量，随明暗切换）。光效只用于「活着」的元素。 */
  shadow: {
    none: "none",
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.18)",
    md: "0 8px 24px -12px rgb(0 0 0 / 0.4)",
    lg: "0 24px 60px -24px rgb(0 0 0 / 0.5)",
    glow: "0 0 0 1px var(--ds-color-accent-soft), 0 0 48px -8px var(--ds-color-accent-glow)",
    "glow-strong": "0 0 0 1px var(--ds-color-accent-soft), 0 0 96px -12px var(--ds-color-accent-glow)",
    ring: "0 0 0 3px var(--ds-color-accent-soft)",
  },
  blur: { glass: "12px", halo: "90px" },

  /** 透明度（用于 opacity-(--ds-opacity-*)） */
  opacity: {
    disabled: "0.45",
    muted: "0.7",
    hover: "0.85",
    halo: "0.55",
    "halo-light": "0.3",
    pattern: "0.5",
  },

  /** 动效：克制。进场 = 淡入 + 上移 6px；呼吸 = 亮度 ±8%，周期 5s，不闪烁。 */
  motion: {
    duration: { fast: "150ms", base: "240ms", slow: "320ms", reveal: "600ms", breath: "5000ms" },
    ease: {
      standard: "cubic-bezier(0.2, 0, 0, 1)",
      emphasized: "cubic-bezier(0.3, 0, 0, 1)",
      breath: "cubic-bezier(0.45, 0, 0.55, 1)",
    },
    revealOffset: "6px",
    breathAmplitude: "0.08",
  },

  /** 字体：人文无衬线。Inter（自托管，拉丁字形）+ 系统中文字体；英文 hero 可用衬线做对比。 */
  font: {
    sans: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans", sans-serif',
    serif: '"Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif CJK SC", Georgia, serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace',
  },
  /** 字号（rem）与行高 */
  text: {
    xs: ["0.75rem", "1.1rem"],
    sm: ["0.875rem", "1.4rem"],
    base: ["1rem", "1.65rem"],
    lg: ["1.125rem", "1.8rem"],
    xl: ["1.25rem", "1.85rem"],
    "2xl": ["1.5rem", "2rem"],
    "3xl": ["1.875rem", "2.3rem"],
    "4xl": ["2.375rem", "2.75rem"],
    "5xl": ["3.125rem", "3.4rem"],
    "6xl": ["4rem", "4.2rem"],
  },
  /** 字重与字距 */
  weight: { normal: "400", medium: "500", semibold: "600" },
  tracking: { tight: "-0.02em", normal: "0", wide: "0.06em" },

  /** 版式宽度与断点 */
  container: { prose: "44rem", content: "72rem", wide: "88rem" },
  breakpoint: { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" },
  /** 高度断点：横屏手机 / 小窗口（配合 short: 变体） */
  shortHeight: "36rem",
  /** 顶栏高度 */
  headerHeight: "3.75rem",
} as const;

export type DesignSystem = typeof designSystem;
