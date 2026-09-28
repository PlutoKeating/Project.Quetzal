// 附件：用户随消息上传的文件（一次最多 MAX_FILES 个）。保存在 WINDLER_HOME/data/uploads/<日期>/ 下。
//   图片 → 直接放进消息（多模态）；路由会自动跳过不支持图片的模型，没有可用的模型时退化为文字说明与路径。
//   文本文件 → 内容插入消息，形成附件列表（过大时只给路径）。
//   其他文件（Word、PPT、表格、PDF……）→ 只给本地路径，由 agent 用 read_document 或命令自己读取。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import { paths } from "../config.ts";
import type { Attachment } from "../store.ts";
import type { Msg, ImagePart } from "../providers/types.ts";
import { loadImage } from "./images.ts";

export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 50 << 20; // 单个文件 50 MiB
const MAX_TEXT_CHARS = 60_000;          // 一条消息内联的文本总量

const IMAGE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" } as Record<string, string>;
const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "kt", "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs", "rb", "php", "swift", "dart", "sh", "bash", "zsh", "ps1", "bat", "sql", "log", "tex", "srt", "vtt", "env", "gitignore", "dockerfile", "makefile", "lua", "r", "m", "scala", "vue", "svelte"]);

const DOC_EXT = new Set(["doc", "docx", "docm", "dotx", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "ppsx", "pdf", "odt", "ods", "odp", "odg", "epub", "rtf", "zip", "7z", "rar", "gz", "tar", "apk", "mp3", "m4a", "wav", "ogg", "mp4", "mov", "mkv"]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export const uploadsDir = () => path.join(paths.data, "uploads");
const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase());
const safeName = (name: string) => path.basename(name).replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").slice(-120) || "file";

/** 判断文件类别与 MIME。 */
export function classify(name: string, head: Buffer = Buffer.alloc(0)): { kind: Attachment["kind"]; mime: string } {
  const e = ext(name);
  if (IMAGE[e]) return { kind: "image", mime: IMAGE[e] };
  if (TEXT_EXT.has(e)) return { kind: "text", mime: "text/plain" };
  if (DOC_EXT.has(e) || head.subarray(0, 4).equals(ZIP) || head.subarray(0, 5).toString() === "%PDF-") return { kind: "file", mime: "application/octet-stream" };
  // 未知扩展名：没有 NUL 字节且能按 UTF-8 解码的当作文本
  if (head.length && !head.includes(0) && [0, 1, 2, 3].some((k) => isUtf8(head.subarray(0, head.length - k)))) return { kind: "text", mime: "text/plain" }; // 末尾可能截断了一个多字节字符
  return { kind: "file", mime: "application/octet-stream" };
}

/** 保存一个上传的文件。 */
export function saveUpload(name: string, data: Buffer): Attachment {
  if (data.length > MAX_FILE_BYTES) throw new Error(`文件过大（${(data.length / 1048576).toFixed(1)} MiB，上限 ${MAX_FILE_BYTES >> 20} MiB）`);
  const id = crypto.randomBytes(6).toString("hex");
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(uploadsDir(), day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-${safeName(name)}`);
  fs.writeFileSync(file, data);
  return fromUpload(path.relative(uploadsDir(), file))!;
}

/** 由 uploads 下的相对路径还原附件信息（客户端回传的附件只按这个路径解析，防止引用任意文件）。 */
export function fromUpload(rel: string): Attachment | undefined {
  const f = resolveUpload(rel);
  if (!f) return undefined;
  const base = path.basename(f), name = base.replace(/^[0-9a-f]{12}-/, "");
  const fd = fs.openSync(f, "r"), head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, 4096, 0); fs.closeSync(fd);
  const { kind, mime } = classify(name, head.subarray(0, n));
  return { id: base.slice(0, 12), name, path: f, rel: path.relative(uploadsDir(), f).split(path.sep).join("/"), mime, size: fs.statSync(f).size, kind };
}

/** 把 uploads 下的相对路径解析成文件（用于下载预览），拒绝越界。 */
export function resolveUpload(rel: string): string | undefined {
  const root = uploadsDir(), f = path.resolve(root, rel);
  return f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : undefined;
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 组装带附件的用户消息。 */
export async function userMessage(header: string, files: Attachment[], instruction: string): Promise<Msg> {
  const images: ImagePart[] = [];
  const lines: string[] = [];
  let inlined = 0;
  for (const [i, f] of files.slice(0, MAX_FILES).entries()) {
    const tag = `${i + 1}. ${f.name}（${size(f.size)}，本地路径 ${f.path}）`;
    try {
      if (f.kind === "image") {
        const { image, note } = await loadImage(f.path);
        images.push(image);
        lines.push(`${tag}：图片，已附在消息中${note ? `（${note}）` : ""}`);
      } else if (f.kind === "text") {
        const text = fs.readFileSync(f.path, "utf8");
        if (inlined + text.length <= MAX_TEXT_CHARS) {
          inlined += text.length;
          lines.push(`${tag}：\n\`\`\`${ext(f.name)}\n${text.replace(/```/g, "ˋˋˋ")}\n\`\`\``);
        } else lines.push(`${tag}：文本文件，内容较长未内联，可用 read_document 或 shell 读取`);
      } else lines.push(`${tag}：文档或其他文件，可用 read_document 读取常见文档（Word、PPT、Excel、PDF、ODF、EPUB、HTML 等），其他格式用 shell 命令处理`);
    } catch (e: any) {
      lines.push(`${tag}：${f.kind === "image" ? "图片无法放进消息" : "读取失败"}（${e.message}），可以用 view_image 或 shell 处理`);
    }
  }
  const body = [header, ...(lines.length ? [`\n附件（${lines.length} 个）：\n${lines.join("\n")}`] : []), `\n${instruction}`].join("\n");
  return images.length ? { role: "user", content: body, images } : { role: "user", content: body };
}
