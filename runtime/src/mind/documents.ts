// 文档读取：把常见文档抽成纯文本，供 read_document 工具分页读取。不引入依赖：
//   OOXML（docx / pptx / xlsx）与 ODF（odt / ods / odp）、EPUB 都是 zip + XML，用内置的 zlib 解压后抽取文字；
//   HTML、RTF、各类文本直接处理；PDF 优先用 pdftotext（poppler），没有时退回简易解析（只能取出未压缩或 Flate 压缩的简单文字）；
//   旧版二进制 doc / xls / ppt 交给 antiword / catdoc / xls2csv / catppt 等命令（没有安装时给出提示）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { run } from "../sh.ts";

export const PAGE_CHARS = 20_000;

// ---------- zip
/** 读取 zip 的全部条目（只支持存储与 deflate，足够应付 Office / ODF / EPUB）。 */
export function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("不是有效的 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : Buffer.alloc(0);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------- XML / HTML
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const tidy = (s: string) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export function htmlToText(html: string) {
  return decode(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** 通用的 XML 抽文字：rules 把段落、单元格等结束标签换成换行或分隔符，其余标签去掉。 */
function xmlText(xml: string, rules: [RegExp, string][]) {
  let s = xml;
  for (const [re, to] of rules) s = s.replace(re, to);
  return tidy(decode(s.replace(/<[^>]+>/g, "")));
}
const num = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);

function docx(z: Map<string, () => Buffer>) {
  const parts = ["word/document.xml", ...[...z.keys()].filter((k) => /^word\/(footnotes|endnotes)\.xml$/.test(k))];
  return parts.filter((k) => z.has(k)).map((k) => xmlText(z.get(k)!().toString("utf8"), [
    [/<w:tab\/>/g, "\t"], [/<w:br[^>]*\/>/g, "\n"], [/<\/w:p>/g, "\n"], [/<\/w:tc>/g, " | "], [/<\/w:tr>/g, "\n"],
  ])).join("\n\n");
}

function pptx(z: Map<string, () => Buffer>) {
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  return slides.map((k) => {
    const text = xmlText(z.get(k)!().toString("utf8"), [[/<\/a:p>/g, "\n"], [/<a:br\/>/g, "\n"]]);
    const notesKey = `ppt/notesSlides/notesSlide${num(k)}.xml`;
    const notes = z.has(notesKey) ? xmlText(z.get(notesKey)!().toString("utf8"), [[/<\/a:p>/g, "\n"]]).replace(/^\d+$/m, "").trim() : "";
    return `--- 第 ${num(k)} 页 ---\n${text}${notes ? `\n（备注）${notes}` : ""}`;
  }).join("\n\n");
}

const colIndex = (ref: string) => [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

function xlsx(z: Map<string, () => Buffer>) {
  const shared = z.has("xl/sharedStrings.xml")
    ? [...z.get("xl/sharedStrings.xml")!().toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, "").replace(/<[^>]+>/g, "")))
    : [];
  const wb = z.has("xl/workbook.xml") ? z.get("xl/workbook.xml")!().toString("utf8") : "";
  const names = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
  const sheets = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  return sheets.map((k, i) => {
    const rows = [...z.get(k)!().toString("utf8").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] ?? "";
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1] ?? "", type = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const val = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? decode((body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "")) : decode(v ?? "");
        cells[ref ? colIndex(ref) : cells.length] = val;
      }
      return Array.from(cells, (x) => x ?? "").join("\t");
    }).filter((r) => r.trim());
    return `--- 工作表：${names[i] ?? `Sheet${i + 1}`}（${rows.length} 行，制表符分隔）---\n${rows.join("\n")}`;
  }).join("\n\n");
}

function odf(z: Map<string, () => Buffer>) {
  if (!z.has("content.xml")) throw new Error("缺少 content.xml");
  return xmlText(z.get("content.xml")!().toString("utf8"), [
    [/<text:tab\/>/g, "\t"], [/<text:s\/>/g, " "], [/<text:line-break\/>/g, "\n"], [/<\/text:(p|h)>/g, "\n"],
    [/<\/table:table-cell>/g, "\t"], [/<\/table:table-row>/g, "\n"], [/<draw:page\b[^>]*draw:name="([^"]*)"[^>]*>/g, "\n--- $1 ---\n"],
  ]);
}

function epub(z: Map<string, () => Buffer>) {
  const opfKey = [...z.keys()].find((k) => k.endsWith(".opf"));
  let order = [...z.keys()].filter((k) => /\.x?html?$/i.test(k));
  if (opfKey) { // 按 spine 顺序
    const opf = z.get(opfKey)!().toString("utf8"), base = path.posix.dirname(opfKey);
    const hrefs = Object.fromEntries([...opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)].map((m) => [m[1], path.posix.join(base === "." ? "" : base, decodeURIComponent(m[2]))]));
    const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => hrefs[m[1]]).filter((k) => k && z.has(k));
    if (spine.length) order = spine;
  }
  return order.map((k) => htmlToText(z.get(k)!().toString("utf8"))).filter(Boolean).join("\n\n");
}

function rtf(s: string) {
  return tidy(s.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^{}]*\}/g, "").replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536)).replace(/\\[a-z]+-?\d* ?/gi, "").replace(/[{}]/g, ""));
}

/** 没有 pdftotext 时的简易解析：解压 Flate 流，取出 Tj / TJ 里的文字（复杂字体编码的中文可能取不到）。 */
function pdfFallback(buf: Buffer) {
  const out: string[] = [];
  const raw = buf.toString("latin1");
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    let s = m[1];
    try { s = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { /* 未压缩 */ }
    const parts = [...s.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ|T\*|ET/g)].map((t) => {
      if (t[0] === "T*" || t[0] === "ET") return "\n";
      return [...t[0].matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((x) => x[1].replace(/\\([nrt()\\])/g, (_, c) => ({ n: "\n", r: "", t: "\t" } as any)[c] ?? c)).join("");
    });
    if (parts.length) out.push(parts.join(""));
  }
  return tidy(out.join("\n"));
}

async function viaCommand(cmds: [string, string[]][], hint: string) {
  for (const [cmd, args] of cmds) {
    const r = await run(cmd, args, 60_000);
    if (r.code === 0 && r.out.trim()) return r.out;
  }
  throw new Error(hint);
}

/** 抽取文档全文。 */
export async function extractText(file: string): Promise<{ kind: string; text: string }> {
  const e = path.extname(file).slice(1).toLowerCase();
  const buf = fs.readFileSync(file);
  const zipped = () => unzip(buf);
  switch (e) {
    case "docx": case "docm": case "dotx": return { kind: "Word", text: docx(zipped()) };
    case "pptx": case "pptm": case "ppsx": return { kind: "PowerPoint", text: pptx(zipped()) };
    case "xlsx": case "xlsm": return { kind: "Excel", text: xlsx(zipped()) };
    case "odt": case "ods": case "odp": case "odg": return { kind: "OpenDocument", text: odf(zipped()) };
    case "epub": return { kind: "EPUB", text: epub(zipped()) };
    case "html": case "htm": case "xhtml": return { kind: "HTML", text: htmlToText(buf.toString("utf8")) };
    case "rtf": return { kind: "RTF", text: rtf(buf.toString("latin1")) };
    case "pdf": {
      try { return { kind: "PDF", text: await viaCommand([["pdftotext", ["-layout", "-enc", "UTF-8", file, "-"]]], "") }; }
      catch {
        const text = pdfFallback(buf);
        return { kind: "PDF", text: text ? `（未安装 pdftotext，以下为简易解析，可能不完整；安装 poppler 后效果更好）\n${text}` : "（未安装 pdftotext，简易解析也没有取出文字：可能是扫描件或使用了复杂字体编码。可以安装 poppler 后重试，例如 Termux 上 pkg install poppler）" };
      }
    }
    case "doc": return { kind: "Word 97-2003", text: await viaCommand([["antiword", [file]], ["catdoc", [file]]], "旧版 .doc 需要 antiword 或 catdoc（Termux：pkg install antiword），或先转换为 docx") };
    case "xls": return { kind: "Excel 97-2003", text: await viaCommand([["xls2csv", [file]]], "旧版 .xls 需要 xls2csv（catdoc 软件包），或先转换为 xlsx") };
    case "ppt": return { kind: "PowerPoint 97-2003", text: await viaCommand([["catppt", [file]]], "旧版 .ppt 需要 catppt（catdoc 软件包），或先转换为 pptx") };
    default: {
      if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) { // 未知的 zip：列出内容
        const z = zipped();
        return { kind: "ZIP 压缩包", text: `压缩包内共 ${z.size} 个条目：\n${[...z.keys()].slice(0, 500).join("\n")}` };
      }
      if (buf.subarray(0, 8192).includes(0)) throw new Error(`无法识别的二进制格式（.${e || "无扩展名"}），可以用 shell 命令（file、strings 等）处理`);
      return { kind: "文本", text: buf.toString("utf8") };
    }
  }
}

/** 分页读取：每次最多 PAGE_CHARS 字，提示下一页的 offset。 */
export async function readDocument(file: string, offset = 0): Promise<string> {
  const f = file.replace(/^file:\/\//, "");
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return `没有这个文件：${f}`;
  const { kind, text } = await extractText(f);
  const start = Math.max(0, Math.floor(offset) || 0), end = Math.min(text.length, start + PAGE_CHARS);
  const more = end < text.length ? `\n\n……（还有 ${text.length - end} 字，用 offset=${end} 继续读）` : "";
  return `【${path.basename(f)}】${kind}，共 ${text.length} 字，本次 ${start}–${end}\n\n${text.slice(start, end)}${more}`;
}
