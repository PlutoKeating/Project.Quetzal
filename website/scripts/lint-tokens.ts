// 构建前检查：app/（design-system/ 除外）里不得出现硬编码的色值、Tailwind 调色板类、任意值外形/透明度/阴影/模糊。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../app", import.meta.url));
const skip = [join(root, "design-system")];
const palette = "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
const rules: Array<[RegExp, string]> = [
  [/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![\w-])/, "字面量十六进制色值"],
  [/\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/, "字面量函数色值"],
  [new RegExp(`\\b(?:bg|text|border|from|via|to|ring|fill|stroke|shadow|outline|decoration|accent|caret|divide)-${palette}-\\d{2,3}\\b`), "Tailwind 调色板类"],
  [/\b(?:bg|text|border|from|via|to|ring|fill|stroke)-(?:white|black)\b/, "white/black 色类"],
  [/\b(?:bg|text|border|from|via|to|ring|fill|stroke|shadow)-[\w-]+\/\d{1,3}\b/, "颜色透明度修饰符（请在 designSystem 里定义带透明度的色）"],
  [/\b(?:rounded(?:-[trbl]{1,2})?|opacity|shadow|blur|backdrop-blur|duration|ease)-\[/, "任意值外形 / 透明度 / 阴影 / 模糊 / 动效"],
  [/\bopacity-\d{1,3}\b/, "数字透明度类（请用 opacity-(--ds-opacity-*)）"],
  [/\b(?:duration|delay)-\d{2,4}\b/, "数字时长类（请用 duration-(--ds-duration-*)）"],
  [/\b(?:drop-)?shadow-(?:xs|sm|md|lg|xl|2xl|none|inner)\b(?!-)/, "Tailwind 内置阴影类（请用 designSystem 的 shadow 键）"],
];

const problems: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip.some((s) => p.startsWith(s))) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css|mdx?)$/.test(name)) check(p);
  }
};
const check = (file: string) => {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes("ds-allow")) return; // 显式豁免（需注明理由）
    for (const [re, why] of rules) {
      const m = re.exec(line);
      if (m) problems.push(`${relative(process.cwd(), file)}:${i + 1}  ${why}: ${m[0]}`);
    }
  });
};
walk(root);
if (problems.length) {
  console.error(`设计系统检查未通过（${problems.length} 处硬编码）：\n` + problems.join("\n"));
  process.exit(1);
}
console.log("设计系统检查通过：app/ 内没有硬编码的视觉参数");
