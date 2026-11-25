import type { ReactNode } from "react";
import type { Block } from "~/lib/content";

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;

/** 极小的行内语法：`code`、**强调**、[链接](地址)。没有 Markdown 解析依赖。 */
export function Inline({ text }: { text: string }): ReactNode {
  const parts = text.split(INLINE).filter((part) => part.length > 0);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          const href = link[2] ?? "#";
          const label = link[1] ?? href;
          return href.startsWith("http") ? (
            <a key={i} href={href} rel="noreferrer noopener">
              {label}
            </a>
          ) : (
            <a key={i} href={href}>
              {label}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function CodeBlock({ text, title }: { text: string; title?: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{title ?? "shell"}</span>
        <span>copy</span>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "p":
            return <p key={i}><Inline text={block.text} /></p>;
          case "h2":
            return <h2 key={i} id={block.id}>{block.text}</h2>;
          case "ul":
            return (
              <ul key={i}>
                {block.items.map((item, j) => <li key={j}><Inline text={item} /></li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {block.items.map((item, j) => <li key={j}><Inline text={item} /></li>)}
              </ol>
            );
          case "code":
            return <CodeBlock key={i} text={block.text} title={block.title} />;
          case "table":
            return (
              <table key={i}>
                <thead>
                  <tr>
                    {block.head.map((cell, j) => <th key={j}><Inline text={cell} /></th>)}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((cell, k) => <td key={k}><Inline text={cell} /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          case "note":
            return (
              <div key={i} className={block.tone === "warn" ? "callout warn" : "callout"}>
                <Inline text={block.text} />
              </div>
            );
          case "steps":
            return (
              <ol key={i} className="steps">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <strong>{item.title}</strong>
                    <span><Inline text={item.text} /></span>
                  </li>
                ))}
              </ol>
            );
          case "cards":
            return (
              <div key={i} className="cards">
                {block.items.map((item, j) => (
                  <div key={j}>
                    <h3>{item.href ? <a href={item.href}>{item.title}</a> : item.title}</h3>
                    <p><Inline text={item.text} /></p>
                  </div>
                ))}
              </div>
            );
        }
      })}
    </>
  );
}
