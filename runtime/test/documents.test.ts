// 文档读取与附件：OOXML / ODF 抽文字、分页、附件分类与消息组装。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-docs-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const docs = await import("../src/mind/documents.ts");
const att = await import("../src/mind/attachments.ts");

/** 极简 zip 写入器（deflate），只用于生成测试文档。 */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), n = Buffer.from(name), crc = zlib.crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, n, data); centrals.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}
const tmpFile = (name: string, data: Buffer | string) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "doc-")), name); fs.writeFileSync(f, data); return f; };

test("Word：段落、表格与实体", async () => {
  const f = tmpFile("a.docx", zip({ "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>第一段 &amp; 标题</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t xml:space="preserve">第二段</w:t></w:r></w:p></w:body></w:document>` }));
  const { kind, text } = await docs.extractText(f);
  assert.equal(kind, "Word");
  assert.match(text, /第一段 & 标题/);
  assert.match(text, /甲\s*\n?\s*\|\s*\n?\s*乙/);
  assert.match(text, /第二段/);
});

test("PowerPoint：按页顺序并带备注", async () => {
  const f = tmpFile("a.pptx", zip({
    "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>`,
    "ppt/slides/slide10.xml": `<p:sld><a:p><a:r><a:t>第十页</a:t></a:r></a:p></p:sld>`,
    "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:sld>`,
    "ppt/notesSlides/notesSlide1.xml": `<p:notes><a:p><a:r><a:t>讲稿</a:t></a:r></a:p></p:notes>`,
  }));
  const { text } = await docs.extractText(f);
  assert.ok(text.indexOf("封面") < text.indexOf("第二页") && text.indexOf("第二页") < text.indexOf("第十页"));
  assert.match(text, /（备注）讲稿/);
});

test("Excel：共享字符串、列位置与工作表名", async () => {
  const f = tmpFile("a.xlsx", zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `<sst><si><t>项目</t></si><si><t>金额</t></si><si><t>咖啡</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>35.5</v></c></row></sheetData></worksheet>`,
  }));
  const { text } = await docs.extractText(f);
  assert.match(text, /工作表：预算（2 行/);
  assert.match(text, /项目\t\t金额/);
  assert.match(text, /咖啡\t\t35\.5/);
});

test("ODF 与分页", async () => {
  const f = tmpFile("a.odt", zip({ "content.xml": `<office:document-content><text:p>你好<text:s/>世界</text:p><text:h>标题</text:h></office:document-content>` }));
  assert.match((await docs.extractText(f)).text, /你好 世界\n标题/);
  const long = tmpFile("long.txt", "字".repeat(docs.PAGE_CHARS + 10));
  const page1 = await docs.readDocument(long);
  assert.match(page1, /共 20010 字，本次 0–20000/);
  assert.match(page1, /用 offset=20000 继续读/);
  assert.match(await docs.readDocument(long, 20000), /本次 20000–20010/);
  assert.match(await docs.readDocument("/不存在/x.docx"), /没有这个文件/);
});

test("附件：分类、保存、只按 uploads 内的路径解析", () => {
  assert.equal(att.classify("a.PNG").kind, "image");
  assert.equal(att.classify("main.py").kind, "text");
  assert.equal(att.classify("x.docx").kind, "file");
  assert.equal(att.classify("noext", Buffer.from("纯文本内容")).kind, "text");
  assert.equal(att.classify("blob", Buffer.from([0, 1, 2])).kind, "file");
  const a = att.saveUpload("../../笔记.md", Buffer.from("# 标题\n内容"));
  assert.equal(a.name, "笔记.md");
  assert.ok(a.path.startsWith(att.uploadsDir()));
  assert.equal(att.fromUpload(a.rel)!.kind, "text");
  assert.equal(att.fromUpload("../../config/quetzal.json"), undefined); // 越界
});

test("附件：组装消息（图片进多模态、文本内联、文档给路径）", async () => {
  const img = att.saveUpload("p.png", Buffer.from("89504e47", "hex"));
  const txt = att.saveUpload("n.txt", Buffer.from("附件正文"));
  const doc = att.saveUpload("r.docx", Buffer.from("PK\x03\x04"));
  const m = await att.userMessage("你 通过控制台对你说：\n看看", [img, txt, doc], "回复对方。") as any;
  assert.equal(m.images.length, 1);
  assert.equal(m.images[0].mime, "image/png");
  assert.match(m.content, /附件（3 个）/);
  assert.match(m.content, /附件正文/);
  assert.match(m.content, /r\.docx.*read_document/);
  assert.equal(((await att.userMessage("x", [], "y")) as any).images, undefined);
});
