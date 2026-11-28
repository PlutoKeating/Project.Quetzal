import type { ReactNode } from "react";
import { Link } from "react-router";
import { FigureById } from "~/diagrams/Figure";
import { type Lang, localized } from "~/i18n/core";
import { type Block, type RailCell, isProse } from "~/lib/content";
import { CopyButton } from "./CopyButton";
import { ArrowRight } from "./icons";

const INLINE = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/** 极小的行内语法：`code` 与 [链接](地址)。站内链接按当前语言补前缀。 */
export function Inline({ text, lang }: { text: string; lang: Lang }): ReactNode {
  const parts = text.split(INLINE).filter((part) => part.length > 0);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          const href = link[2] ?? "#";
          const label = link[1] ?? href;
          return href.startsWith("http") ? (
            <a key={i} href={href} rel="noreferrer noopener">
              {label}
            </a>
          ) : (
            <Link key={i} to={localized(lang, href)}>
              {label}
            </Link>
          );
        }
        return part;
      })}
    </>
  );
}

/** 命令块：等宽、永远 LTR、右上角一个小复制按钮。 */
export function Command({ text, label, head, lang }: { text: string; label?: string; head?: string; lang: Lang }) {
  return (
    <div className="qz-cmd">
      {label ? (
        <p className="qz-cmd-label">
          <Inline text={label} lang={lang} />
        </p>
      ) : null}
      <div className="qz-cmd-frame">
        {head ? (
          <div className="qz-cmd-head">
            <span>{head}</span>
          </div>
        ) : null}
        <div className="qz-cmd-body" dir="ltr">
          <code className="qz-cmd-text is-mono">{text}</code>
          <CopyButton text={text} variant="qz-btn-copy" />
        </div>
      </div>
    </div>
  );
}

/** 一句对他说的话：琥珀色的 > 表示「这是人说的」，文字不用等宽。 */
export function Saying({ text, label, lang }: { text: string; label?: string; lang: Lang }) {
  return (
    <div className="qz-cmd">
      {label ? (
        <p className="qz-cmd-label">
          <Inline text={label} lang={lang} />
        </p>
      ) : null}
      <div className="qz-cmd-frame">
        <div className="qz-cmd-body">
          <span className="qz-caret" dir="ltr" aria-hidden="true">
            &gt;
          </span>
          <span className="qz-cmd-text">{text}</span>
          <CopyButton text={text} variant="qz-btn-copy" />
        </div>
      </div>
    </div>
  );
}

function numClass(tone: RailCell["tone"]): string {
  return tone ? `qz-cell-num is-${tone}` : "qz-cell-num";
}

/** 发丝线栅格：卡片的替代品。 */
export function Rail({ cols, head, cells, grid, lang }: { cols: 2 | 3 | 4; head?: { name: string; meta?: string }; cells: RailCell[]; grid?: boolean; lang: Lang }) {
  const size = cols === 4 ? "" : ` is-${cols}`;
  return (
    <>
      {head ? (
        <div className="qz-rail-head">
          <span className="qz-caret" dir="ltr" aria-hidden="true">
            &gt;
          </span>
          <span>{head.name}</span>
          {head.meta ? <span className="qz-meta">{head.meta}</span> : null}
        </div>
      ) : null}
      <div className={`qz-rail${grid ? " is-grid" : ""}${size}`}>
        {cells.map((cell) => (
          <div key={cell.title} className={cell.accent ? "qz-cell is-accent" : "qz-cell"}>
            {cell.num ? (
              <span className={numClass(cell.tone)} dir="ltr">
                {cell.num}
              </span>
            ) : null}
            <h3>
              {cell.href ? (
                <Link to={localized(lang, cell.href)}>
                  {cell.title}
                  <ArrowRight className="qz-dir-arrow site-inline-arrow" />
                </Link>
              ) : (
                cell.title
              )}
            </h3>
            <p>
              <Inline text={cell.text} lang={lang} />
            </p>
            {cell.line ? (
              cell.line.kind === "say" ? (
                <span className="qz-meta site-cell-line">
                  <span className="qz-caret" dir="ltr" aria-hidden="true">
                    &gt;{" "}
                  </span>
                  {cell.line.text}
                </span>
              ) : (
                <span className="qz-meta site-cell-line" dir={cell.line.kind === "cmd" ? "ltr" : undefined}>
                  {cell.line.text}
                </span>
              )
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

function ProseBlock({ block, lang }: { block: Block; lang: Lang }) {
  switch (block.kind) {
    case "p":
      return (
        <p>
          <Inline text={block.text} lang={lang} />
        </p>
      );
    case "h2":
      return (
        <h2 id={block.id}>
          {block.step ? <span className="qz-step-no">{block.step}</span> : null}
          {block.text}
        </h2>
      );
    case "h3":
      return <h3>{block.text}</h3>;
    case "ul":
      return (
        <ul>
          {block.items.map((item) => (
            <li key={item}>
              <Inline text={item} lang={lang} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol>
          {block.items.map((item) => (
            <li key={item}>
              <Inline text={item} lang={lang} />
            </li>
          ))}
        </ol>
      );
    case "cmd":
      return <Command text={block.text} label={block.label} head={block.head} lang={lang} />;
    case "say":
      return <Saying text={block.text} label={block.label} lang={lang} />;
    case "table":
      return (
        <table>
          <thead>
            <tr>
              {block.head.map((cell) => (
                <th key={cell} scope="col">
                  <Inline text={cell} lang={lang} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.join("|")}>
                {row.map((cell, k) => (
                  <td key={k}>
                    <Inline text={cell} lang={lang} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "note":
      return (
        <blockquote>
          <p>
            <Inline text={block.text} lang={lang} />
          </p>
        </blockquote>
      );
    case "figure":
    case "rail":
      return null;
  }
}

/**
 * 把内容块渲染成正文。连续的长文块包进同一个 .qz-prose；
 * 栅格和图不属于长文（.qz-prose 会改写它们的段落间距），单独成块。
 */
export function Blocks({ blocks, lang }: { blocks: Block[]; lang: Lang }) {
  const groups: { prose: boolean; items: Block[] }[] = [];
  for (const block of blocks) {
    const prose = isProse(block);
    const last = groups[groups.length - 1];
    if (last && last.prose && prose) last.items.push(block);
    else groups.push({ prose, items: [block] });
  }
  return (
    <>
      {groups.map((group, i) => {
        if (group.prose) {
          return (
            <div key={i} className="qz-prose">
              {group.items.map((block, j) => (
                <ProseBlock key={j} block={block} lang={lang} />
              ))}
            </div>
          );
        }
        const block = group.items[0];
        if (!block) return null;
        if (block.kind === "figure") {
          return (
            <div key={i} className="site-block">
              <FigureById id={block.id} lang={lang} />
            </div>
          );
        }
        if (block.kind === "rail") {
          return (
            <div key={i} className="site-block">
              <Rail cols={block.cols} head={block.head} cells={block.cells} grid lang={lang} />
            </div>
          );
        }
        return null;
      })}
    </>
  );
}
