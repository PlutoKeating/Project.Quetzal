import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 视觉语言只有一份：packages/design-system。这里守住三件事——
// 页面骨架按系统规范；治理面自己不带任何样式与数值；追加进设计系统的组件不破它的硬规则。

const WEB = process.cwd();
const DESIGN = resolve(WEB, "../../packages/design-system");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** 去掉注释：下面的约束说的是代码，不是说明代码的话。 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

/** 治理面自己的源码：`src/cache` 与 `src/worker` 是另一条产品线的地基，不在其中。 */
function surfaceSources(): Array<{ path: string; text: string }> {
  return walk(join(WEB, "src"))
    .map((path) => relative(WEB, path))
    .filter((path) => !path.startsWith("src/cache/") && !path.startsWith("src/worker/"))
    .map((path) => ({ path, text: withoutComments(read(join(WEB, path))) }));
}

describe("页面骨架按设计系统的规范", () => {
  const page = new DOMParser().parseFromString(read(join(WEB, "index.html")), "text/html");

  it("光学地平线与胶片颗粒是 body 最前面的两个元素，内容在 .qz-page 里", () => {
    const [first, second, third] = Array.from(page.body.children);
    expect(first?.className).toBe("qz-optical-horizon");
    expect(first?.getAttribute("aria-hidden")).toBe("true");
    expect(second?.className).toBe("qz-grain");
    expect(second?.getAttribute("aria-hidden")).toBe("true");
    expect(third?.className).toBe("qz-page");
    expect(third?.querySelector("#app")?.classList.contains("qz-app")).toBe(true);
    expect(page.body.children).toHaveLength(3);
  });

  it("只有深色，没有浅色模式", () => {
    expect(page.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("dark");
  });

  it("没有内联脚本、内联样式和远程依赖", () => {
    for (const script of page.querySelectorAll("script")) {
      expect(script.textContent?.trim()).toBe("");
      expect(script.getAttribute("src")).toMatch(/^\/assets\/[a-z]+\.js$/u);
    }
    expect(page.querySelectorAll("style")).toHaveLength(0);
    expect(page.querySelectorAll("[style]")).toHaveLength(0);
    const links = Array.from(page.querySelectorAll("link")).map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/assets/styles.css"]);
    expect(read(join(WEB, "index.html"))).not.toMatch(/https?:\/\/|\/\/cdn|@import/u);
  });

  it("脚本只有两份：应用本身，和设计系统的光学脚本", () => {
    const scripts = Array.from(page.querySelectorAll("script")).map((script) => ({
      src: script.getAttribute("src"),
      type: script.getAttribute("type"),
      defer: script.hasAttribute("defer"),
    }));
    expect(scripts).toEqual([
      { src: "/assets/optics.js", type: null, defer: true },
      { src: "/assets/app.js", type: "module", defer: false },
    ]);
  });

  it("CSP 保持原有的约束：同源、无内联、无 eval", () => {
    const csp = page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toMatch(/'unsafe-eval'/u);
    expect(csp).not.toMatch(/https?:|\*/u);
  });
});

describe("治理面自己不带样式，也不重述数值", () => {
  it("源码里没有样式表", () => {
    const styles = walk(join(WEB, "src")).filter((path) => /\.(css|scss|less)$/u.test(path));
    expect(styles).toEqual([]);
  });

  it("构建从 packages/design-system 取样式、字体与光学脚本", () => {
    const build = read(join(WEB, "build.mjs"));
    expect(build).toContain("../../packages/design-system");
    expect(build).toContain('join(design, "styles.css")');
    expect(build).toContain('join(design, "scripts/optics.js")');
    expect(build).toContain('".woff2": "file"');
    // 设计系统的入口确实在那里。
    expect(read(join(DESIGN, "styles.css"))).toContain("components/components.css");
    expect(statSync(join(DESIGN, "scripts/optics.js")).isFile()).toBe(true);
  });

  it("源码里没有颜色、尺寸和断点的字面量", () => {
    for (const { path, text } of surfaceSources()) {
      // 颜色：十六进制、rgb()、hsl()。
      expect(text, path).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/u);
      expect(text, path).not.toMatch(/\b(?:rgba?|hsla?|oklch)\(/u);
      // 尺寸与断点：px、rem、媒体查询。
      expect(text, path).not.toMatch(/\d(?:px|rem|em|vh|vw)\b/u);
      expect(text, path).not.toMatch(/max-width|min-width|matchMedia/u);
    }
  });

  it("不写内联样式：只经 CSSOM 把数据写进设计系统声明的自定义属性", () => {
    const writes: string[] = [];
    for (const { path, text } of surfaceSources()) {
      expect(text, path).not.toMatch(/setAttribute\(\s*["']style["']/u);
      expect(text, path).not.toMatch(/\.style\.(?!setProperty\()/u);
      expect(text, path).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
      for (const match of text.matchAll(/\.style\.setProperty\(\s*["']([^"']+)["']/gu)) {
        writes.push(match[1] ?? "");
      }
    }
    expect(writes).toEqual(["--qz-scale-limit"]);
  });

  it("用到的每一个 qz- 类都在设计系统里有定义；元素 id 用 sea- 前缀，不占用它", () => {
    const defined = new Set<string>();
    for (const file of walk(join(DESIGN, "tokens")).concat(join(DESIGN, "components/components.css"))) {
      for (const match of read(file).matchAll(/\.(qz-[a-z0-9-]+)/gu)) defined.add(match[1] ?? "");
    }
    const used = new Set<string>();
    const sources = [...surfaceSources(), { path: "index.html", text: read(join(WEB, "index.html")) }];
    for (const { text } of sources) {
      // 前面是连字符的不算：那是 data-qz-lit 这样的属性和 --qz-* 自定义属性。
      for (const match of text.matchAll(/(?<![\w-])(qz-[a-z]+(?:-[a-z0-9]+)*)(?![\w-])/gu)) {
        used.add(match[1] ?? "");
      }
    }
    expect(used.size).toBeGreaterThan(60);
    expect([...used].filter((name) => !defined.has(name)).sort()).toEqual([]);
  });

  it("旧的对话控制台没有留下任何痕迹", () => {
    const sources = [
      ...surfaceSources(),
      { path: "index.html", text: read(join(WEB, "index.html")) },
      { path: "build.mjs", text: read(join(WEB, "build.mjs")) },
      { path: "e2e/mock-daemon.mjs", text: read(join(WEB, "e2e/mock-daemon.mjs")) },
    ];
    const gone = [
      /web_commit_artifact/u,
      /WebSocket|websocket/u,
      /sendChat|"chat"|composer/iu,
      /companion|workbench|inspector|density/iu,
      /ViewPatch|ViewSnapshot|rpc\/snapshot/u,
      /a11y_streaming|messageId|onToken/u,
      /web-composer-draft|draft_cache/u,
      /@deprecated|已废弃|兼容旧/u,
    ];
    for (const { path, text } of sources) {
      for (const pattern of gone) {
        expect(text, `${path} 不应再出现 ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe("追加进设计系统的应用组件不破它的硬规则", () => {
  const css = read(join(DESIGN, "components/components.css"));
  const marker = "Application components";
  const added = css.slice(css.indexOf(marker));

  it("追加的部分存在，并且在原有规则之后", () => {
    expect(css.indexOf(marker)).toBeGreaterThan(css.indexOf(".qz-footer-links"));
    expect(added.length).toBeGreaterThan(2000);
  });

  it("只用 token：没有颜色字面量，没有第三种颜色", () => {
    expect(added).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(added).not.toMatch(/\b(?:rgba?|hsla?)\(/u);
    expect(added).not.toMatch(/--qz-spectrum/u);
    expect(added).not.toMatch(/\b(?:red|green|blue|purple|orange|yellow)\b/u);
  });

  it("没有加粗：字重只有 400 与 500", () => {
    const weights = Array.from(added.matchAll(/font-weight:\s*([^;]+);/gu), (match) => match[1]?.trim());
    expect(weights.length).toBeGreaterThan(0);
    expect(new Set(weights)).toEqual(new Set(["400", "500"]));
  });

  it("只有浮层有阴影，没有新的模糊", () => {
    const shadows = Array.from(added.matchAll(/box-shadow:\s*([^;]+);/gu), (match) => match[1]?.trim());
    expect(shadows).toEqual(["var(--qz-shadow-popover)"]);
    expect(added.slice(added.indexOf(".qz-dialog {"), added.indexOf(".qz-dialog::backdrop"))).toContain(
      "box-shadow: var(--qz-shadow-popover)",
    );
    expect(added).not.toMatch(/backdrop-filter|filter:\s*blur/u);
    expect(added).not.toMatch(/text-shadow|drop-shadow/u);
  });

  it("只有透明度与颜色在动：没有位移、缩放、关键帧", () => {
    expect(added).not.toMatch(/@keyframes|animation\s*:/u);
    expect(added).not.toMatch(/transform\s*:|translate\s*:|scale\s*:|rotate\s*:/u);
    const allowed = /^(?:opacity|background|border-color|color|text-decoration-color)$/u;
    for (const match of added.matchAll(/transition:\s*([^;]+);/gu)) {
      for (const part of (match[1] ?? "").split(",")) {
        const property = part.trim().split(/\s+/u)[0] ?? "";
        expect(property, `transition 只能作用于颜色与透明度：${part.trim()}`).toMatch(allowed);
      }
    }
  });

  it("按钮不用胶囊圆角，不用琥珀色", () => {
    const blocks = Array.from(added.matchAll(/(\.qz-btn[^{]*)\{([^}]*)\}/gu));
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      expect(body, selector).not.toMatch(/--qz-radius-dot|999px|--qz-amber/u);
    }
  });

  it("只追加新的规则：原有的部分一个字没动", () => {
    // 原有规则以这一条 print 规则收尾；它之后才是追加的部分。
    const original = css.slice(0, css.indexOf(marker));
    expect(original).toContain(".qz-prose h2::after,\n  .qz-seam {\n    display: none;\n  }\n}");
    expect(original.match(/^\.qz-[a-z-]+ \{$/gmu)?.length).toBeGreaterThan(60);
  });
});
