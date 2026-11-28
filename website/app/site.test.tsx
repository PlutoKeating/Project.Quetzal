// 页面不变量：把每个页面 × 每种语言渲染成静态 HTML，逐页检查骨架、设计系统硬规则与文案事实。
// 构建产物上的同类断言在 scripts/postbuild.mjs（那里看到的是真正的 <body>）。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { OpticalLayers, SiteShell } from "./components/SiteShell";
import { LANGS, type Lang, localized } from "./i18n/core";
import { officialHubNote } from "./i18n/hub";
import type { Block, Messages } from "./lib/content";
import { DOC_NAV, MOVED, NOT_FOUND_PATHS, PAGE_PATHS, isReadingPath, prerenderPaths } from "./lib/pages";
import Commands from "./routes/docs/commands/route";
import { messages as commandsMessages } from "./routes/docs/commands/i18n";
import Connect from "./routes/docs/connect/route";
import { messages as connectMessages } from "./routes/docs/connect/i18n";
import Devices from "./routes/docs/devices/route";
import { messages as devicesMessages } from "./routes/docs/devices/i18n";
import Export from "./routes/docs/export/route";
import { messages as exportMessages } from "./routes/docs/export/i18n";
import Governance from "./routes/docs/governance/route";
import { messages as governanceMessages } from "./routes/docs/governance/i18n";
import InHost from "./routes/docs/in-host/route";
import { messages as inHostMessages } from "./routes/docs/in-host/i18n";
import DocsIndex from "./routes/docs/index/route";
import { messages as indexMessages } from "./routes/docs/index/i18n";
import Install from "./routes/docs/install/route";
import { messages as installMessages } from "./routes/docs/install/i18n";
import ReleaseSigning from "./routes/docs/release-signing/route";
import { RELEASE_PUBKEY, messages as signingMessages } from "./routes/docs/release-signing/i18n";
import SelfHostHub from "./routes/docs/self-host-hub/route";
import { messages as hubMessages } from "./routes/docs/self-host-hub/i18n";
import Trust from "./routes/docs/trust/route";
import { messages as trustMessages } from "./routes/docs/trust/i18n";
import Download from "./routes/download/route";
import Home from "./routes/home/route";
import NotFound from "./routes/not-found";

const DOC_PAGES: Record<string, { Page: ComponentType; messages: Messages }> = {
  "/docs": { Page: DocsIndex, messages: indexMessages },
  "/docs/start/install": { Page: Install, messages: installMessages },
  "/docs/start/connect": { Page: Connect, messages: connectMessages },
  "/docs/guide/in-host": { Page: InHost, messages: inHostMessages },
  "/docs/guide/governance": { Page: Governance, messages: governanceMessages },
  "/docs/guide/devices": { Page: Devices, messages: devicesMessages },
  "/docs/guide/export": { Page: Export, messages: exportMessages },
  "/docs/guide/trust": { Page: Trust, messages: trustMessages },
  "/docs/advanced/self-host-hub": { Page: SelfHostHub, messages: hubMessages },
  "/docs/reference/commands": { Page: Commands, messages: commandsMessages },
  "/docs/reference/release-signing": { Page: ReleaseSigning, messages: signingMessages },
};

const TOP: Record<string, ComponentType> = { "/": Home, "/download": Download };

type Rendered = { path: string; bare: string; lang: Lang; html: string; text: string; kind: "landing" | "doc" | "missing" };

function render(path: string, Page: ComponentType): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <OpticalLayers reading={isReadingPath(path)} />
      <SiteShell>
        <Page />
      </SiteShell>
    </MemoryRouter>,
  );
}

/** 去掉标签与注释，只留访客读到的字（含 aria-label 之外的全部文本）。 */
function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

const pages: Rendered[] = [];
for (const lang of LANGS) {
  for (const [bare, Page] of Object.entries(TOP)) {
    const path = localized(lang, bare);
    const html = render(path, Page);
    pages.push({ path, bare, lang, html, text: textOf(html), kind: "landing" });
  }
  for (const [bare, { Page }] of Object.entries(DOC_PAGES)) {
    const path = localized(lang, bare);
    const html = render(path, Page);
    pages.push({ path, bare, lang, html, text: textOf(html), kind: "doc" });
  }
}
for (const path of NOT_FOUND_PATHS) {
  const html = render(path, NotFound);
  pages.push({ path, bare: "/404", lang: path.startsWith("/en/") ? "en" : "zh", html, text: textOf(html), kind: "missing" });
}

const count = (html: string, needle: string | RegExp): number =>
  typeof needle === "string" ? html.split(needle).length - 1 : (html.match(needle) ?? []).length;

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const designCss = [
  ...readdirSync(here("../../packages/design-system/tokens")).map((f) => readFileSync(here(`../../packages/design-system/tokens/${f}`), "utf8")),
  readFileSync(here("../../packages/design-system/components/components.css"), "utf8"),
].join("\n");
const siteCss = readFileSync(here("./site.css"), "utf8");

describe("site map", () => {
  it("renders every page of the site map in every language", () => {
    expect(Object.keys({ ...TOP, ...DOC_PAGES }).sort()).toEqual([...PAGE_PATHS].sort());
    expect(pages.length).toBe(PAGE_PATHS.length * LANGS.length + NOT_FOUND_PATHS.length);
  });

  it("prerenders each page in both languages plus a 404 for each language", () => {
    const paths = prerenderPaths();
    for (const path of NOT_FOUND_PATHS) expect(paths).toContain(path);
    for (const path of PAGE_PATHS) {
      expect(paths).toContain(path);
      expect(paths).toContain(localized("en", path));
    }
    expect(paths.length).toBe(PAGE_PATHS.length * 2 + NOT_FOUND_PATHS.length);
  });

  it("has a route module and a bilingual copy file for every doc, and nothing left over", () => {
    const dirs = readdirSync(here("./routes/docs")).sort();
    expect(dirs).toEqual(DOC_NAV.map((d) => d.dir).sort());
    for (const dir of dirs) {
      expect(existsSync(here(`./routes/docs/${dir}/route.tsx`)), dir).toBe(true);
      expect(existsSync(here(`./routes/docs/${dir}/i18n.ts`)), dir).toBe(true);
    }
  });

  it("no longer has the pages that described removed features, and redirects each to a live page", () => {
    const live = new Set(PAGE_PATHS);
    for (const [from, to] of MOVED) {
      expect(live.has(from), from).toBe(false);
      expect(live.has(to), to).toBe(true);
    }
    for (const gone of ["linux", "macos", "windows", "multi-body", "other-machines", "custom-adapter", "spine-backup"]) {
      expect(DOC_NAV.some((d) => d.path.endsWith(`/${gone}`)), gone).toBe(false);
    }
  });

  it("links only to pages that exist", () => {
    const known = new Set(prerenderPaths());
    for (const page of pages) {
      for (const match of page.html.matchAll(/href="(\/[^"#]*)(#[^"]*)?"/g)) {
        const href = match[1] ?? "";
        if (href.startsWith("/dl/") || href === "/favicon.svg") continue;
        expect(known.has(href), `${page.path} links to ${href}`).toBe(true);
      }
    }
  });

  it("keeps links inside the visitor's language", () => {
    for (const page of pages.filter((p) => p.lang === "en")) {
      const main = page.html.slice(page.html.indexOf("<main"), page.html.indexOf("</main>"));
      for (const match of main.matchAll(/href="(\/[^"]*)"/g)) {
        const href = match[1] ?? "";
        expect(href === "/en" || href.startsWith("/en/"), `${page.path} links to ${href}`).toBe(true);
      }
    }
  });
});

describe("page shell", () => {
  it("puts the optical horizon and the grain first, and wraps the content in .qz-page", () => {
    for (const page of pages) {
      expect(page.html, page.path).toMatch(/^<div class="qz-optical-horizon[^"]*" aria-hidden="true"><\/div><div class="qz-grain" aria-hidden="true"><\/div><div class="qz-page/);
      expect(count(page.html, 'class="qz-optical-horizon'), page.path).toBe(1);
      expect(page.html.endsWith("</footer></div>"), page.path).toBe(true);
    }
  });

  it("sends the language switch on an unknown address to that language's home page", () => {
    for (const page of pages.filter((p) => p.kind === "missing")) {
      const menu = page.html.slice(page.html.indexOf('role="menu"'), page.html.indexOf("</details>"));
      expect([...menu.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), page.path).toEqual(["/", "/en"]);
    }
  });

  it("uses reading mode on documentation pages and only there", () => {
    for (const page of pages) {
      const reading = page.html.startsWith('<div class="qz-optical-horizon is-reading"');
      expect(reading, page.path).toBe(page.kind === "doc");
      expect(page.html.includes("site-reading"), page.path).toBe(page.kind === "doc");
    }
  });

  it("gives documentation the three panes: side navigation, prose, table of contents", () => {
    for (const page of pages.filter((p) => p.kind === "doc")) {
      expect(count(page.html, 'class="qz-sidenav '), page.path).toBe(1);
      expect(count(page.html, 'class="qz-toc '), page.path).toBe(1);
      expect(page.html, page.path).toContain('class="qz-prose"');
      const side = page.html.slice(page.html.indexOf("qz-sidenav "), page.html.indexOf("</aside>"));
      expect(count(side, 'aria-current="page"'), page.path).toBe(1);
      expect(count(side, "<a "), page.path).toBe(DOC_NAV.length);
    }
  });

  it("has exactly one h1 per page", () => {
    for (const page of pages) expect(count(page.html, "<h1"), page.path).toBe(1);
  });

  it("marks the brand with the spectrum wordmark in the nav bar, at most twice per page", () => {
    for (const page of pages) {
      expect(page.html, page.path).toMatch(/class="qz-brand"[^>]*><span class="qz-wordmark">Quetzalcoatl<\/span>/);
      expect(count(page.html, "qz-wordmark"), page.path).toBeLessThanOrEqual(2);
    }
  });
});

describe("design system hard rules", () => {
  it("has one white primary button where a page has a primary action, and never two", () => {
    for (const page of pages) {
      // 落地页与 404 各有一个主操作；文档是阅读面，复制用框内的小按钮，没有白色主按钮。
      expect(count(page.html, "qz-btn-white"), page.path).toBe(page.kind === "doc" ? 0 : 1);
    }
  });

  it("uses only classes that the design system or the site layout defines", () => {
    const old = new Set(["wrap", "btn", "hero", "card", "cards", "grid", "nav", "section", "prose", "brand", "skip", "steps", "eyebrow", "callout", "codeblock", "badge", "site-head", "site-foot", "not-found"]);
    for (const page of pages) {
      for (const match of page.html.matchAll(/class="([^"]*)"/g)) {
        for (const name of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
          expect(old.has(name), `${page.path}: old class .${name}`).toBe(false);
          if (name.startsWith("site-")) expect(siteCss.includes(`.${name}`), `${page.path}: .${name} is not in site.css`).toBe(true);
          else expect(new RegExp(`\\.${name}(?![\\w-])`).test(designCss), `${page.path}: .${name} is not in the design system`).toBe(true);
        }
      }
    }
  });

  it("never restyles inline and never uses bold", () => {
    for (const page of pages) {
      expect(page.html, page.path).not.toMatch(/\sstyle="/);
      expect(page.html, page.path).not.toMatch(/<(strong|b)[\s>]/);
      expect(page.html, page.path).not.toMatch(/font-weight="(600|700|800|900|bold)"/);
    }
  });

  it("draws every diagram as an inline SVG with a text alternative, and uses no screenshots", () => {
    for (const page of pages) {
      expect(page.html, page.path).not.toContain("<img");
      for (const match of page.html.matchAll(/<svg[^>]*class="qz-diagram"[^>]*>/g)) {
        expect(match[0], page.path).toContain('role="img"');
        expect(match[0], page.path).toMatch(/aria-label="[^"]{20,}"/);
      }
    }
    const home = pages.find((p) => p.path === "/");
    expect(count(home?.html ?? "", 'class="qz-diagram"')).toBeGreaterThanOrEqual(4);
  });

  it("shows a figure or a hairline rail on every page instead of stacking text", () => {
    for (const page of pages.filter((p) => p.kind !== "missing")) {
      const structure = count(page.html, 'class="qz-diagram"') + count(page.html, /class="qz-rail[ "]/g) + count(page.html, "<table");
      expect(structure, page.path).toBeGreaterThanOrEqual(1);
    }
  });

  it("writes without exclamation marks or emoji", () => {
    for (const page of pages) {
      expect(page.text, page.path).not.toMatch(/[!！]/);
      expect(page.text, page.path).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("copy matches the product", () => {
  const banned: [string, RegExp][] = [
    ["qz chat", /qz chat/i],
    ["a web console", /控制台|\bconsole\b/i],
    ["an API key prompt", /API\s?Key/i],
    ["the three densities", /三档|陪伴|工作台|检视|\bCompanion\b|\bWorkbench\b|\bInspector\b|densit/i],
    ["mobile clients", /\biOS\b|\bAndroid\b|\biPhone\b|\biPad\b/i],
    ["a built-in model proxy", /模型代理|model proxy|内置模型/i],
    ["the old product name", /Quetzal(?!coatl)\b(?!\.)/],
    ["the old tagline", /主权 Agent 操作系统|sovereign agent OS/i],
  ];

  it("never mentions features that no longer exist", () => {
    for (const page of pages) {
      const prose = page.text.replace(/Project\.Quetzal/g, "");
      for (const [what, pattern] of banned) expect(pattern.test(prose), `${page.path} mentions ${what}`).toBe(false);
    }
  });

  it("only mentions voice and phone apps to say they are not there", () => {
    for (const page of pages) {
      if (page.bare === "/") continue;
      expect(page.text, page.path).not.toMatch(/语音|\bvoice\b|手机 App|phone app/i);
    }
  });

  it("states the positioning on the home page", () => {
    const zh = pages.find((p) => p.path === "/")?.text ?? "";
    for (const phrase of ["人格、价值、关系与记忆", "带权威等级并签名", "跟着你的设备走", "经独立审查才写回", "不是什么"]) expect(zh).toContain(phrase);
    const en = pages.find((p) => p.path === "/en")?.text ?? "";
    for (const phrase of ["ranked by authority", "signed", "independent review", "What it is not"]) expect(en).toContain(phrase);
  });

  it("puts the install command in one command bar on the home and download pages", () => {
    for (const path of ["/", "/en", "/download", "/en/download"]) {
      const html = pages.find((p) => p.path === path)?.html ?? "";
      expect(count(html, 'class="qz-command-bar"'), path).toBe(1);
      expect(html, path).toContain("curl -fsSL https://quetzal.plutokeating.beer/install | bash");
    }
  });

  it("documents every command of this release and no other", () => {
    const all = pages.map((p) => p.text).join("\n");
    for (const cmd of ["qz connect", "qz connect --undo", "qz doctor", "qz status", "qz up", "qz down", "qz open", "qz export", "qz import", "qz import-v1", "qz login", "qz pair"]) {
      expect(all, cmd).toContain(cmd);
    }
    const known = new Set(["connect", "doctor", "status", "up", "down", "open", "export", "import", "import-v1", "login", "pair"]);
    for (const page of pages) {
      for (const match of page.text.matchAll(/\bqz ([a-z][a-z0-9-]*)/g)) expect(known.has(match[1] ?? ""), `${page.path}: qz ${match[1]}`).toBe(true);
    }
  });

  it("says the official Hub sentence in one place in the source, shown on the two Hub pages only", () => {
    for (const lang of LANGS) {
      for (const page of pages.filter((p) => p.lang === lang && p.kind !== "missing")) {
        const expected = page.bare === "/docs/guide/devices" || page.bare === "/docs/advanced/self-host-hub" ? 1 : 0;
        expect(count(page.text, officialHubNote[lang]), page.path).toBe(expected);
        if (expected === 0) expect(page.text, page.path).not.toMatch(/官方 Hub|official Hub/i);
      }
    }
  });

  it("prints the same release public key as the installer", () => {
    const installer = readFileSync(here("../../scripts/install.sh"), "utf8");
    expect(installer).toContain(`RELEASE_PUBKEY="${RELEASE_PUBKEY}"`);
  });
});

describe("both languages stay in step", () => {
  const shape = (block: Block): string => {
    switch (block.kind) {
      case "rail":
        return `rail:${block.cols}:${block.cells.length}:${block.cells.map((c) => `${c.href ?? ""}|${c.line?.kind ?? ""}`).join(",")}`;
      case "table":
        return `table:${block.head.length}x${block.rows.length}`;
      case "ul":
      case "ol":
        return `${block.kind}:${block.items.length}`;
      case "h2":
        return `h2:${block.id}:${block.step ?? ""}`;
      case "figure":
        return `figure:${block.id}`;
      default:
        return block.kind;
    }
  };

  it("gives every documentation page the same structure in Chinese and English", () => {
    for (const [path, { messages }] of Object.entries(DOC_PAGES)) {
      expect(messages.zh.doc.blocks.map(shape), path).toEqual(messages.en.doc.blocks.map(shape));
    }
  });

  it("keeps commands identical across languages", () => {
    const commands = (m: Messages, lang: Lang) => m[lang].doc.blocks.flatMap((b) => (b.kind === "cmd" && !b.text.includes("#") && !b.text.includes("<") ? [b.text] : []));
    for (const [path, { messages }] of Object.entries(DOC_PAGES)) expect(commands(messages, "zh"), path).toEqual(commands(messages, "en"));
  });

  it("keeps inline code out of hairline cells, where the design system does not style it", () => {
    for (const { messages } of Object.values(DOC_PAGES)) {
      for (const lang of LANGS) {
        for (const block of messages[lang].doc.blocks) {
          if (block.kind === "rail") for (const cell of block.cells) expect(cell.text).not.toContain("`");
        }
      }
    }
  });
});
