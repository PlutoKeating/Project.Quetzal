import { DocShell } from "~/components/DocShell";
import { chrome, useLang } from "~/i18n/core";
import type { Block } from "~/lib/content";
import { docMeta } from "~/lib/meta";
import { DOC_NAV } from "~/lib/pages";
import { messages } from "./i18n";

export const meta = ({ location }: { location: { pathname: string } }) => docMeta(messages, location);

/** 文档总览：先一张图，再一条命令，最后是全部页面的目录（发丝线栅格，直接取自站点地图）。 */
export default function Page() {
  const lang = useLang();
  const m = messages[lang];
  const pages = DOC_NAV.filter((d) => d.path !== "/docs");
  const directory: Block = {
    kind: "rail",
    cols: 2,
    head: { name: m.directory, meta: String(pages.length).padStart(2, "0") },
    cells: pages.map((d) => ({
      num: chrome[lang].docs.sections[d.section],
      title: d.label[lang],
      text: d.summary[lang],
      href: d.path,
    })),
  };
  return <DocShell path="/docs" doc={{ ...m.doc, blocks: [...m.doc.blocks, directory] }} />;
}
