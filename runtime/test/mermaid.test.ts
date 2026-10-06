// Mermaid 的兜底渲染：输出是 flutter_svg 能显示的静态 SVG（具体颜色、没有样式表、变量、color-mix 与 marker），箭头还在，主题换色。
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMermaidSvg, resolveColor } from "../src/mermaid.ts";

test("颜色表达式算成具体值", () => {
  const vars = { "--bg": "#ffffff", "--fg": "#000000", "--_line": "var(--line, color-mix(in srgb, var(--fg) 50%, var(--bg)))" };
  assert.equal(resolveColor("var(--_line)", vars), "#808080");
  assert.equal(resolveColor("var(--nope, #123)", vars), "#112233");
  assert.equal(resolveColor("color-mix(in srgb, var(--fg) 25%, var(--bg))", vars), "#bfbfbf");
});

test("各类图都整理成静态 SVG，暗色主题换色，不认识的类型报错", async () => {
  for (const code of ["flowchart LR\n A[开始] -->|是| B{判断}\n B -.-> C((结束))", "sequenceDiagram\n A->>B: 你好\n B-->>A: 收到", "stateDiagram-v2\n [*] --> 醒着\n 醒着 --> [*]"]) {
    const light = await renderMermaidSvg(code), dark = await renderMermaidSvg(code, true);
    for (const s of [light, dark]) {
      assert.match(s, /^<svg\b/);
      for (const bad of ["<style", "var(", "color-mix", "<marker", "@import", "marker-end", "foreignObject"]) assert.ok(!s.includes(bad), `${bad} 不该出现`);
      assert.match(s, /<polygon\b/, "箭头画成多边形");
    }
    assert.match(light, /#27272a/); assert.match(dark, /#e4e4e7/);
  }
  await assert.rejects(() => renderMermaidSvg("pie\n \"a\": 1"));
  await assert.rejects(() => renderMermaidSvg("   "), /没有图/);
});
