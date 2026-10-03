/** 自写的小插件：GitHub 告示块（remark）与标题收集（rehype）。 */
import type { Root as MdRoot, Blockquote, Paragraph, Text } from "mdast";
import type { Root as HastRoot, Element } from "hast";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";

export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";
export interface HeadingItem { id: string; text: string; depth: 2 | 3 }

/** `> [!NOTE]` 等 GitHub 告示块：标记到 blockquote 的 data-alert，并去掉首行标记。 */
export function remarkAlerts() {
  return (tree: MdRoot) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const first = node.children[0];
      if (!first || first.type !== "paragraph") return;
      const p = first as Paragraph;
      const head = p.children[0];
      if (!head) return;
      let kind: AlertKind | null = null;
      if (head.type === "linkReference") {
        // `[!NOTE]` 在 CommonMark 里会被解析成没有定义的引用链接
        const m = /^!(note|tip|important|warning|caution)$/i.exec(head.identifier ?? "");
        if (!m) return;
        kind = m[1].toLowerCase() as AlertKind;
        p.children.shift();
        const rest = p.children[0];
        if (rest && rest.type === "text") (rest as Text).value = (rest as Text).value.replace(/^\s*\n?/, "");
      } else if (head.type === "text") {
        const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/.exec((head as Text).value);
        if (!m) return;
        kind = m[1].toLowerCase() as AlertKind;
        (head as Text).value = (head as Text).value.slice(m[0].length);
        if (!(head as Text).value) p.children.shift();
      } else return;
      if (!p.children.length) node.children.shift();
      node.data = { ...node.data, hProperties: { ...(node.data as { hProperties?: object } | undefined)?.hProperties, "data-alert": kind } };
    });
  };
}

/** 收集 h2 / h3（需在 rehype-slug 之后），写入传入的数组。 */
export function rehypeCollectHeadings(sink: HeadingItem[]) {
  return (tree: HastRoot) => {
    sink.length = 0;
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "h2" && node.tagName !== "h3") return;
      const id = typeof node.properties?.id === "string" ? node.properties.id : "";
      if (!id) return;
      sink.push({ id, text: toString(node), depth: node.tagName === "h2" ? 2 : 3 });
    });
  };
}
