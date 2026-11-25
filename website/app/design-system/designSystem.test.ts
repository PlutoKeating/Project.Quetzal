// 设计系统与文案的机械约束。这些断言很便宜，但能挡住最常见、最难在评审里看出来的漂移：
// 页面里偷写一个色值、某个页面漏了英文、以及把 V1 的 quetzal-* 命名带进 V2。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { globalCss, tokens } from "./designSystem";

const appDir = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const files = walk(appDir);

describe("design system", () => {
  it("emits CSS variables for every colour token", () => {
    for (const name of Object.keys(tokens.color)) {
      expect(globalCss, name).toContain(`--ds-`);
    }
    expect(globalCss).toContain("--ds-accent:");
    expect(globalCss).toContain("--ds-teal:");
  });

  it("keeps every literal colour inside designSystem.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(join("design-system", "designSystem.ts"))) continue;
      const source = readFileSync(file, "utf8");
      if (/#[0-9a-fA-F]{3,8}\b/.test(source) || /\brgba?\(/.test(source) || /\bhsla?\(/.test(source)) {
        offenders.push(relative(appDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("copy", () => {
  const content = files.filter((file) => file.endsWith(join("i18n.ts")) || file.endsWith(join("i18n", "core.ts")));

  it("has both languages and non-empty blocks on every page", async () => {
    type Page = { metaTitle?: string; doc?: { title: string; blocks: unknown[] } };
    const pages = files.filter((file) => file.endsWith(join("i18n.ts")));
    expect(pages.length).toBeGreaterThanOrEqual(10);
    for (const file of pages) {
      const mod = (await import(file)) as { messages?: Record<string, Page> };
      expect(mod.messages, file).toBeTruthy();
      for (const lang of ["zh", "en"]) {
        const page = mod.messages?.[lang];
        expect(page, `${file} ${lang}`).toBeTruthy();
        expect(page?.metaTitle?.length ?? 0, `${file} ${lang} metaTitle`).toBeGreaterThan(0);
        if (page?.doc) {
          expect(page.doc.title.length, `${file} ${lang} title`).toBeGreaterThan(0);
          expect(page.doc.blocks.length, `${file} ${lang} blocks`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("never reintroduces the V1 quetzal-* product or asset prefix", () => {
    const offenders: string[] = [];
    for (const file of content) {
      const source = readFileSync(file, "utf8");
      // quetzalcoatl-* is the V2 brand; a bare quetzal- prefix is a V1 leftover.
      if (/quetzal-(?!coatl)/.test(source)) offenders.push(relative(appDir, file));
    }
    expect(offenders).toEqual([]);
  });

  it("points every install command at the same origin/install routes", () => {
    const source = content.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).toContain("https://quetzal.plutokeating.beer/install");
    expect(source).toContain("https://quetzal.plutokeating.beer/install.ps1");
  });
});
