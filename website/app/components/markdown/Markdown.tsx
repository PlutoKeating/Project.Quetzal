/**
 * 统一的 Markdown 渲染组件：文档页、GitHub 发布说明等全站复用。
 * GFM（表格、任务列表、脚注、删除线、自动链接）+ GitHub 告示块 + LaTeX（KaTeX）+ emoji 短代码 + shiki 高亮（懒加载）+ mermaid（懒加载）。
 * 在浏览器与预渲染（Node）两端都能工作；mermaid 与 shiki 只在客户端挂载后加载。
 */
import { isValidElement, useEffect, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkEmoji from "remark-emoji";
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import { Link } from "react-router";
import "katex/dist/katex.min.css";
import { cx } from "~/design-system/components";
import { useMessages } from "~/i18n/core";
import { CodeBlock } from "./CodeBlock";
import { Mermaid } from "./Mermaid";
import { ZoomImage } from "./Lightbox";
import { mdMessages } from "./i18n";
import { remarkAlerts, rehypeCollectHeadings, type AlertKind, type HeadingItem } from "./plugins";

export type { HeadingItem };

export interface MarkdownProps {
  source: string;
  className?: string;
  /** 文档页用：为标题生成 id 并回传目录（h2 / h3） */
  onHeadings?: (h: HeadingItem[]) => void;
  /** 站内链接转换（例如给 /docs/... 加语言前缀） */
  linkBase?: (href: string) => string;
}

const alertTone: Record<AlertKind, string> = {
  note: "border-secondary text-secondary-fg",
  tip: "border-success text-success",
  important: "border-link text-link",
  warning: "border-warning text-warning",
  caution: "border-danger text-danger",
};

function codeFromPre(children: ReactNode): { code: string; lang: string } | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement(child)) return null;
  const props = (child as ReactElement<{ className?: string; children?: ReactNode }>).props;
  const lang = /language-([\w+-]+)/.exec(props.className ?? "")?.[1] ?? "";
  const text = Array.isArray(props.children) ? props.children.join("") : String(props.children ?? "");
  return { code: text.replace(/\n$/, ""), lang };
}

const isExternal = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

export function Markdown({ source, className, onHeadings, linkBase }: MarkdownProps) {
  const t = useMessages(mdMessages);
  const headings = useRef<HeadingItem[]>([]);

  const rehypePlugins = useMemo(() => [rehypeSlug, [rehypeKatex, { output: "html" }] as never, [rehypeCollectHeadings, headings.current] as never], []);
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath, remarkAlerts, [remarkEmoji, { accessible: true }] as never], []);

  useEffect(() => { onHeadings?.([...headings.current]); }, [source, onHeadings]);

  const components: Components = useMemo(() => ({
    pre: ({ children }) => {
      const c = codeFromPre(children);
      if (!c) return <pre>{children}</pre>;
      if (c.lang === "mermaid") return <Mermaid code={c.code} />;
      return <CodeBlock code={c.code} lang={c.lang} />;
    },
    code: ({ className: cn, children, ...rest }) => <code className={cx("md-inline-code", cn)} {...rest}>{children}</code>,
    a: ({ href = "", children, node: _n, ...rest }) => {
      if (href.startsWith("#")) return <a href={href} {...rest}>{children}</a>;
      if (isExternal(href)) return <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>{children}</a>;
      const to = linkBase ? linkBase(href) : href;
      return <Link to={to} {...rest}>{children}</Link>;
    },
    img: ({ node: _n, alt, ...rest }) => <ZoomImage alt={alt} {...rest} />,
    table: ({ node: _n, children, ...rest }) => <div className="md-table-wrap my-5 overflow-x-auto"><table {...rest}>{children}</table></div>,
    blockquote: ({ node, children, ...rest }) => {
      const kind = (node?.properties as { dataAlert?: string } | undefined)?.dataAlert as AlertKind | undefined;
      if (!kind) return <blockquote {...rest}>{children}</blockquote>;
      return (
        <aside role="note" className={cx("md-alert my-5 rounded-md border-l-(length:--ds-border-thick) bg-surface px-4 py-3", alertTone[kind])}>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide">{t.alert[kind]}</p>
          <div className="text-fg">{children}</div>
        </aside>
      );
    },
    h2: ({ node: _n, id, children, ...rest }) => <h2 id={id} {...rest}><a href={`#${id}`} className="md-anchor" aria-label={t.anchor}>#</a>{children}</h2>,
    h3: ({ node: _n, id, children, ...rest }) => <h3 id={id} {...rest}><a href={`#${id}`} className="md-anchor" aria-label={t.anchor}>#</a>{children}</h3>,
    input: ({ node: _n, ...rest }) => <input {...rest} disabled className="md-task" />,
  }), [linkBase, t]);

  return (
    <div className={cx("prose-docs", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>{source}</ReactMarkdown>
    </div>
  );
}
