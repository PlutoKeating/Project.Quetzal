// 由 designSystem.ts 生成 app/design-system/tokens.generated.css（不入库，构建前自动执行）。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { designSystem as ds } from "../app/design-system/designSystem.ts";

const out = fileURLToPath(new URL("../app/design-system/tokens.generated.css", import.meta.url));
const lines: string[] = ["/* 自动生成：请修改 designSystem.ts，不要手改本文件 */"];

const colorVars = (scheme: "dark" | "light") =>
  Object.entries(ds.colors[scheme]).map(([k, v]) => `  --ds-color-${k}: ${v};`).join("\n");

const statics: string[] = [];
for (const [k, v] of Object.entries(ds.radius)) statics.push(`  --ds-radius-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.borderWidth)) statics.push(`  --ds-border-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.shadow)) statics.push(`  --ds-shadow-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.blur)) statics.push(`  --ds-blur-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.opacity)) statics.push(`  --ds-opacity-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.motion.duration)) statics.push(`  --ds-duration-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.motion.ease)) statics.push(`  --ds-ease-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.font)) statics.push(`  --ds-font-${k}: ${v};`);
for (const [k, [size, lh]] of Object.entries(ds.text)) statics.push(`  --ds-text-${k}: ${size};`, `  --ds-text-${k}--line-height: ${lh};`);
for (const [k, v] of Object.entries(ds.container)) statics.push(`  --ds-container-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.weight)) statics.push(`  --ds-weight-${k}: ${v};`);
for (const [k, v] of Object.entries(ds.tracking)) statics.push(`  --ds-tracking-${k}: ${v};`);
statics.push(`  --ds-reveal-offset: ${ds.motion.revealOffset};`, `  --ds-breath-amplitude: ${ds.motion.breathAmplitude};`);
statics.push(`  --ds-header-height: ${ds.headerHeight};`);

lines.push(`:root {\n  color-scheme: dark;\n${colorVars("dark")}\n${statics.join("\n")}\n}`);
lines.push(`@media (prefers-color-scheme: light) {\n  :root:not([data-theme="dark"]) {\n    color-scheme: light;\n${colorVars("light").replace(/^/gm, "  ")}\n  }\n}`);
lines.push(`:root[data-theme="light"] {\n  color-scheme: light;\n${colorVars("light")}\n}`);

// Tailwind v4 主题映射：工具类名 → CSS 变量（inline 让类直接引用变量，随明暗切换）
const theme: string[] = [];
theme.push("  --color-*: initial;", "  --radius-*: initial;", "  --shadow-*: initial;", "  --blur-*: initial;", "  --ease-*: initial;", "  --font-*: initial;", "  --text-*: initial;", "  --container-*: initial;", "  --breakpoint-*: initial;", "  --font-weight-*: initial;", "  --tracking-*: initial;", "  --animate-*: initial;");
for (const k of Object.keys(ds.colors.dark)) theme.push(`  --color-${k}: var(--ds-color-${k});`);
for (const k of Object.keys(ds.radius)) theme.push(`  --radius-${k}: var(--ds-radius-${k});`);
for (const k of Object.keys(ds.shadow)) theme.push(`  --shadow-${k}: var(--ds-shadow-${k});`);
for (const k of Object.keys(ds.blur)) theme.push(`  --blur-${k}: var(--ds-blur-${k});`);
for (const k of Object.keys(ds.motion.ease)) theme.push(`  --ease-${k}: var(--ds-ease-${k});`);
for (const k of Object.keys(ds.font)) theme.push(`  --font-${k}: var(--ds-font-${k});`);
for (const k of Object.keys(ds.text)) theme.push(`  --text-${k}: var(--ds-text-${k});`, `  --text-${k}--line-height: var(--ds-text-${k}--line-height);`);
for (const k of Object.keys(ds.container)) theme.push(`  --container-${k}: var(--ds-container-${k});`);
for (const [k, v] of Object.entries(ds.breakpoint)) theme.push(`  --breakpoint-${k}: ${v};`);
for (const k of Object.keys(ds.weight)) theme.push(`  --font-weight-${k}: var(--ds-weight-${k});`);
for (const k of Object.keys(ds.tracking)) theme.push(`  --tracking-${k}: var(--ds-tracking-${k});`);
theme.push("  --animate-breath: ds-breath var(--ds-duration-breath) var(--ds-ease-breath) infinite;", "  --animate-reveal: ds-reveal var(--ds-duration-reveal) var(--ds-ease-emphasized) both;");
lines.push(`@theme inline {\n${theme.join("\n")}\n}`);

// 关键帧：呼吸（亮度 ± 幅度，不闪烁）与进场（淡入 + 上移）
lines.push(`@keyframes ds-breath {\n  0%, 100% { opacity: calc(1 - var(--ds-breath-amplitude)); transform: scale(1); }\n  50% { opacity: 1; transform: scale(1.04); }\n}`);
lines.push(`@keyframes ds-reveal {\n  from { opacity: 0; transform: translateY(var(--ds-reveal-offset)); }\n  to { opacity: 1; transform: translateY(0); }\n}`);
// 自托管 Inter（OFL，public/fonts/LICENSE-Inter.txt）
lines.push(`@font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/fonts/InterVariable.woff2") format("woff2"); }`);
// 斜体（首页 hero 的副标）：与正体同一次构建，取自 Inter 作者发布的 npm 包 inter-ui 4.1.1；只在有斜体文字的页面才下载
lines.push(`@font-face { font-family: "Inter"; font-style: italic; font-weight: 100 900; font-display: swap; src: url("/fonts/InterVariable-Italic.woff2") format("woff2"); }`);

// 横屏手机 / 矮窗口变体
lines.push(`@custom-variant short (@media (max-height: ${ds.shortHeight}));`);

writeFileSync(out, lines.join("\n\n") + "\n");
console.log(`已生成 ${out}`);
