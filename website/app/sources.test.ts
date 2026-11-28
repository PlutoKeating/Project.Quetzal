// 源码不变量：官网只引用 packages/design-system，不另存一套视觉语言，也不留旧的那一套。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const site = fileURLToPath(new URL("..", import.meta.url));
const system = fileURLToPath(new URL("../../packages/design-system", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const read = (path: string): string => readFileSync(path, "utf8");
const rel = (path: string): string => relative(site, path);

/** 官网自己写的源码：页面、组件、图、版面胶水、静态资源与构建脚本（不含测试与生成物）。 */
const sources = [...walk(join(site, "app")), ...walk(join(site, "public")), ...walk(join(site, "scripts"))].filter(
  (path) => !/\.test\.tsx?$/.test(path),
);
const authored = sources.filter((path) => /\.(tsx?|css|svg|mjs)$/.test(path));

const systemCss = [...walk(join(system, "tokens")), join(system, "components", "components.css")].map(read).join("\n");
const systemAll = [systemCss, read(join(system, "scripts", "optics.js")), read(join(system, "guidelines", "diagrams.md")), read(join(system, "guidelines", "components.md")), read(join(system, "README.md"))].join("\n");

const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|color)\([^)]*\)/g;
const normalize = (color: string): string => color.toLowerCase().replace(/\s+/g, "");

describe("the site uses the design system and nothing else", () => {
  it("imports styles, fonts and the optics script from packages/design-system", () => {
    const root = read(join(site, "app", "root.tsx"));
    expect(root).toContain('from "@design/styles.css?url"');
    expect(root).toContain('from "@design/scripts/optics.js?url&no-inline"');
    expect(root).toMatch(/from "@design\/fonts\/sora-latin-500-normal\.woff2\?url"/);
    const vite = read(join(site, "vite.config.ts"));
    expect(vite).toContain("../packages/design-system");
  });

  it("keeps no copy of the system: no fonts, no token files, no optics script in the site", () => {
    for (const path of sources) {
      expect(/\.(woff2?|ttf|otf)$/.test(path), rel(path)).toBe(false);
      expect(/(^|\/)optics\.js$/.test(path), rel(path)).toBe(false);
    }
    expect(existsSync(join(site, "app", "design-system"))).toBe(false);
  });

  it("has exactly one stylesheet of its own, and it defines no colour and restyles no component", () => {
    const sheets = sources.filter((path) => path.endsWith(".css")).map(rel);
    expect(sheets).toEqual(["app/site.css"]);
    const css = read(join(site, "app", "site.css")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css.match(COLOR) ?? []).toEqual([]);
    expect(css).not.toMatch(/\.qz-/);
    expect(css).not.toMatch(/box-shadow|text-shadow|backdrop-filter|transform|transition|animation|@keyframes|font-weight|border-radius/);
    for (const selector of css.matchAll(/(^|[\s,}])\.([a-z][\w-]*)/g)) expect(selector[2]?.startsWith("site-"), selector[2]).toBe(true);
  });

  it("references only custom properties that the design system defines", () => {
    for (const path of authored) {
      for (const match of read(path).matchAll(/var\((--[\w-]+)/g)) {
        const name = match[1] ?? "";
        expect(systemCss.includes(`${name}:`), `${rel(path)}: ${name}`).toBe(true);
      }
    }
    const css = read(join(site, "app", "site.css"));
    for (const match of css.matchAll(/^\s*(--[\w-]+)\s*:/gm)) expect(systemCss.includes(`${match[1]}:`), match[1]).toBe(true);
  });

  it("uses no colour literal outside the design system's own vocabulary", () => {
    const vocabulary = new Set((systemAll.match(COLOR) ?? []).map(normalize));
    for (const path of authored) {
      for (const color of read(path).match(COLOR) ?? []) {
        expect(vocabulary.has(normalize(color)), `${rel(path)}: ${color}`).toBe(true);
      }
    }
  });

  it("keeps colour literals to the two places the diagram rules require", () => {
    const withLiterals = authored.filter((path) => (read(path).match(COLOR) ?? []).length > 0).map(rel);
    expect(withLiterals.sort()).toEqual(["app/diagrams/kit.tsx", "public/favicon.svg"]);
  });

  it("names only design-system classes and tokens that exist", () => {
    for (const path of authored.filter((p) => /\.tsx?$/.test(p))) {
      for (const match of read(path).matchAll(/(?<![\w-])qz-[a-z][a-z0-9-]*/g)) {
        const name = match[0];
        const known = systemAll.includes(`.${name}`) || systemAll.includes(`--${name}`) || systemAll.includes(`data-${name}`);
        expect(known, `${rel(path)}: ${name}`).toBe(true);
      }
    }
  });

  it("leaves no trace of the previous design system", () => {
    const residue = /--ds-|designSystem|globalCss|hero-grid|hero-aside|doc-shell|doc-side|codeblock|release-panel|platform-tabs|foot-grid|brand-sub|lang-switch|#1D4ED8|#0F172A/i;
    for (const path of authored) expect(residue.test(read(path)), rel(path)).toBe(false);
    expect(read(join(site, "README.md"))).not.toMatch(/design-system\/designSystem|designSystem\.ts/);
  });
});
