import { useEffect, useState } from "react";
import { useMessages } from "~/i18n/core";
import { cx } from "~/design-system/components";
import { mdMessages } from "./i18n";

type Highlighter = (code: string, lang: string) => Promise<string>;
let highlighterPromise: Promise<Highlighter> | null = null;

/** 懒加载 shiki（只在页面出现代码块时），主题为 CSS 变量主题：颜色由 app.css 里的 --shiki-* → --ds-color-* 决定。 */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= Promise.all([import("shiki/bundle/web"), import("shiki/core")]).then(([web, core]) => {
    const theme = core.createCssVariablesTheme({ name: "ds", variablePrefix: "--shiki-", variableDefaults: {}, fontStyle: true });
    return async (code, lang) => {
      const known = (web.bundledLanguages as Record<string, unknown>)[lang] != null;
      return web.codeToHtml(code, { lang: known ? lang : "text", theme });
    };
  });
  return highlighterPromise;
}

/** 语言别名：文档里常见写法 → shiki 名。 */
const aliases: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", yml: "yaml", kts: "kotlin", "ts": "typescript", "js": "javascript", txt: "text", plain: "text", "": "text" };

export function CodeBlock({ code, lang, className }: { code: string; lang: string; className?: string }) {
  const t = useMessages(mdMessages);
  const language = aliases[lang] ?? lang;
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    if (language === "text") return;
    getHighlighter().then((hl) => hl(code, language)).then((h) => { if (alive) setHtml(h); }).catch(() => { /* 保持纯文本 */ });
    return () => { alive = false; };
  }, [code, language]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* 剪贴板不可用 */ }
  };

  return (
    <div className={cx("md-code group relative my-5 overflow-hidden rounded-lg border border-border bg-code-bg", className)}>
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-fg-subtle">
        <span>{language}</span>
        <button type="button" onClick={copy} className="rounded-sm px-2 py-0.5 text-fg-muted transition-colors duration-(--ds-duration-fast) hover:bg-surface-hover hover:text-fg">
          {copied ? t.copied : t.copy}
        </button>
      </div>
      {html ? (
        <div className="md-shiki overflow-x-auto p-4 text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto p-4 text-sm leading-relaxed text-code-fg"><code>{code}</code></pre>
      )}
    </div>
  );
}
