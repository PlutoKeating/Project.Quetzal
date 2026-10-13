"""从研究目录中的 PDF 生成 Markdown、插图和完整逐页原图。"""

import argparse
import hashlib
import json
import os
import re
from importlib.metadata import version
from pathlib import Path

import pymupdf
import pymupdf4llm


ROOT = Path(__file__).resolve().parents[1]
DPI = 160


def restore_headings(text):
    """将转换器仅加粗的独立章节行恢复为 Markdown 标题。"""
    def numbered(match):
        number, title = match.groups()
        level = min(3 + number.count("."), 6)
        return f"{'#' * level} {number} {title.replace('**', '')}"

    text = re.sub(
        r"^\*\*(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\*\* +\*\*(.+)\*\*$",
        numbered, text, flags=re.MULTILINE,
    )
    return re.sub(r"^\*\*(Abstract|References)\*\*$", r"### \1", text, flags=re.MULTILINE)


def extract(metadata_path):
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    paper = metadata_path.parent / "paper"
    pdf = paper / "original" / f"{metadata['arxiv_id']}.pdf"
    pdf_hash = hashlib.sha256(pdf.read_bytes()).hexdigest()
    if pdf_hash != metadata["pdf_sha256"]:
        raise ValueError(f"PDF 校验值不符：{pdf}")
    output = paper / "markdown"
    for directory in ["assets/figures", "assets/pages"]:
        (output / directory).mkdir(parents=True, exist_ok=True)

    # 使用传统布局提取，无需模型下载或 OCR；原图负责完整保存视觉内容。
    pymupdf4llm.use_layout(False)
    previous = Path.cwd()
    try:
        os.chdir(output)
        with pymupdf.open(pdf) as document:
            chunks = pymupdf4llm.to_markdown(
                document,
                filename=metadata["arxiv_id"],
                write_images=True,
                image_path="assets/figures",
                image_format="png",
                dpi=DPI,
                force_text=True,
                page_chunks=True,
                margins=0,
                show_progress=False,
            )
            sections = [
                f"# {metadata['title']}\n\n"
                "> 本文由 PDF 自动提取，尚未逐项人工校对。每页附完整原图，"
                "用于核对图片、图表、公式与布局。\n"
            ]
            pages = []
            for index, (page, chunk) in enumerate(zip(document, chunks, strict=True), 1):
                snapshot = f"assets/pages/page-{index:03}.png"
                page.get_pixmap(dpi=DPI, alpha=False).save(snapshot)
                sections.append(
                    f"\n## PDF 第 {index} 页\n\n{restore_headings(chunk['text']).strip()}\n\n"
                    f"<details>\n<summary>本页完整原图（核对图表与公式）</summary>\n\n"
                    f"![PDF 第 {index} 页完整原图]({snapshot})\n\n</details>\n"
                )
                pages.append({"page": index, "snapshot": snapshot})
            (output / "paper.md").write_text("\n".join(sections), encoding="utf-8")
            manifest = {
                "arxiv_id": metadata["arxiv_id"],
                "pdf_sha256": pdf_hash,
                "pages": len(document),
                "dpi": DPI,
                "tools": {name: version(name) for name in ["pymupdf", "pymupdf4llm"]},
                "layout": "legacy",
                "human_reviewed": False,
                "page_assets": pages,
                "figure_assets": sorted(
                    str(path.relative_to(output)) for path in (output / "assets/figures").glob("*.png")
                ),
            }
            (output / "extraction.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            print(f"{metadata['arxiv_id']}：{len(document)} 页，提取完成", flush=True)
    finally:
        os.chdir(previous)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paper", help="仅提取指定 arXiv 编号；省略则提取全部论文")
    args = parser.parse_args()
    metadata_paths = sorted(ROOT.glob("*/metadata.json"))
    if args.paper:
        metadata_paths = [
            path for path in metadata_paths
            if json.loads(path.read_text(encoding="utf-8"))["arxiv_id"] == args.paper
        ]
    if not metadata_paths:
        parser.error("未找到对应论文")
    for metadata_path in metadata_paths:
        extract(metadata_path)
