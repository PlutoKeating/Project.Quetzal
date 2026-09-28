// 图片：把本地图片准备成多模态消息的一部分（附件、view_image 工具共用）。
//   手机照片常有 5–10 MB，超过多数模型接口的上限，所以较大的图片先缩到长边 MAX_EDGE 像素的 JPEG：
//   依次尝试 ffmpeg、ImageMagick（magick / convert），都没有时原图不超过 MAX_RAW 就直接发，否则给出明确提示。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../sh.ts";
import type { ImagePart } from "../providers/types.ts";

const SHRINK_OVER = 1_500_000; // 超过就缩
const MAX_RAW = 4_500_000;      // 无法缩图时，原图的上限
const MAX_EDGE = 1600;

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

/** 按扩展名或文件头判断图片类型；不是图片返回 undefined。 */
export function imageMime(file: string, head?: Buffer): string | undefined {
  const byExt = MIME[path.extname(file).slice(1).toLowerCase()];
  if (byExt) return byExt;
  const h = head ?? Buffer.alloc(0);
  if (h[0] === 0xff && h[1] === 0xd8) return "image/jpeg";
  if (h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (h.subarray(0, 4).toString() === "GIF8") return "image/gif";
  if (h.subarray(0, 4).toString() === "RIFF" && h.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return undefined;
}

async function shrink(file: string): Promise<string | undefined> {
  const out = path.join(os.tmpdir(), `windler-img-${process.pid}-${Date.now()}.jpg`);
  const tries: [string, string[]][] = [
    ["ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vf", `scale='if(gt(iw,ih),min(${MAX_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_EDGE},ih))'`, "-frames:v", "1", "-q:v", "4", out]],
    ["magick", [file, "-auto-orient", "-resize", `${MAX_EDGE}x${MAX_EDGE}>`, "-quality", "85", out]],
    ["convert", [file, "-auto-orient", "-resize", `${MAX_EDGE}x${MAX_EDGE}>`, "-quality", "85", out]],
  ];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args, 60_000);
    if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  }
  return undefined;
}

/** 读取一张本地图片，必要时缩小。返回图片数据与说明（例如「已缩小」）。 */
export async function loadImage(file: string): Promise<{ image: ImagePart; note: string }> {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`没有这个文件：${file}`);
  const fd = fs.openSync(file, "r"), head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
  const mime = imageMime(file, head);
  if (!mime) throw new Error(`不是可识别的图片：${path.basename(file)}`);
  const size = fs.statSync(file).size;
  if (size > SHRINK_OVER) {
    const small = await shrink(file);
    if (small) {
      const data = fs.readFileSync(small).toString("base64");
      const kb = Math.round(fs.statSync(small).size / 1024);
      fs.rmSync(small, { force: true });
      return { image: { mime: "image/jpeg", data }, note: `原图 ${(size / 1048576).toFixed(1)} MB，已缩小到长边 ${MAX_EDGE} 像素（${kb} KB）` };
    }
    if (size > MAX_RAW) throw new Error(`图片太大（${(size / 1048576).toFixed(1)} MB），且没有可用的缩图工具（ffmpeg / ImageMagick）`);
  }
  return { image: { mime, data: fs.readFileSync(file).toString("base64") }, note: "" };
}
