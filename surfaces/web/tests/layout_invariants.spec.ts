import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
  return match?.[1] ?? "";
}

describe("320px / 200% 字号布局不变量（断言设计令牌而非截图像素）", () => {
  it("Companion 触控目标令牌为 64px 且按钮使用变量", () => {
    expect(css).toContain("--tap-target: 64px");
    expect(block(".btn")).toContain("min-height: var(--tap-target)");
  });

  it("根字号使用百分比以便浏览器 200% 缩放生效（不以 px 写死正文）", () => {
    expect(block(":root")).toContain("font-size: 100%");
    expect(/font-size:\s*\d+px/u.test(css)).toBe(false);
  });

  it("容器无固定像素宽度，长词可任意换行（零截断）", () => {
    expect(/[\s;{](?:width|height):\s*\d+px/u.test(css)).toBe(false);
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).not.toContain("text-overflow: ellipsis");
  });

  it("小屏断点存在且不缩小触控目标", () => {
    expect(css).toContain("@media (max-width: 420px)");
    const media = css.slice(css.indexOf("@media (max-width: 420px)"));
    expect(media).toContain("--tap-target: 64px");
  });

  it("气泡与表单只设 min-height，放大字号时不被裁切", () => {
    expect(block(".composer textarea")).toContain("min-height:");
    expect(css).not.toMatch(/\.(message|composer|tier)[^{]*\{[^}]*height:\s*\d+px/u);
  });

  it("jsdom 计算样式确实挂上 min-height 变量", () => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const button = document.createElement("button");
    button.className = "btn";
    document.body.append(button);
    const computed = getComputedStyle(button);
    // jsdom 会把 var() 解析为令牌值；二者出现其一都证明按钮确实挂上了 64pt 触控目标。
    expect(["var(--tap-target)", "64px"]).toContain(computed.minHeight);
    style.remove();
    button.remove();
  });
});
