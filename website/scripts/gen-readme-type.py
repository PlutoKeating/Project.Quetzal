#!/usr/bin/env python3
"""生成 README 用的「艺术字」SVG：文字转成轮廓路径，不依赖阅读者机器上的字体，GitHub 的图片代理也能原样显示。
输出 ../docs/assets/readme/type/<名字>.<dark|light>.svg，README 里用 <picture> 按深浅色切换。
字体：Noto Serif CJK SC（系统 fonts-noto-cjk，OFL；拉丁字形也用它，中西统一）。颜色取 designSystem.ts 的 fg。
用法：python3 scripts/gen-readme-type.py"""
from pathlib import Path
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = Path(__file__).resolve().parent.parent.parent / "docs" / "assets" / "readme" / "type"
COLORS = {"dark": ("#e8e4dd", "#f0a35e"), "light": ("#26221e", "#c9772e")}  # 文字、琥珀

def face(path, name):
    for f in TTCollection(path).fonts:
        if f["name"].getDebugName(1) == name: return f
    raise SystemExit(f"{path} 里没有 {name}")

SERIF = face("/usr/share/fonts/opentype/noto/NotoSerifCJK-Medium.ttc", "Noto Serif CJK SC Medium")
SANS = face("/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc", "Noto Sans CJK SC Medium")

def line_paths(font, text, size, x, baseline, tracking=0):
    """一行文字 → (路径列表, 行宽)。"""
    cmap = font.getBestCmap(); gs = font.getGlyphSet(); hmtx = font["hmtx"]
    k = size / font["head"].unitsPerEm; paths = []; cx = x
    for ch in text:
        name = cmap.get(ord(ch), ".notdef")
        pen = SVGPathPen(gs); gs[name].draw(TransformPen(pen, (k, 0, 0, -k, cx, baseline)))
        d = pen.getCommands()
        if d: paths.append(d)
        cx += hmtx[name][0] * k + tracking
    return paths, cx - x

def svg(name, lines, font, size, leading, align="left", rule=False):
    """lines：若干行文字；rule：标题前的一颗琥珀小点（与官网的状态灯同一颗）。"""
    measured = [line_paths(font, t, size, 0, 0) for t in lines]
    width = max(w for _, w in measured); pad = 2; lead_in = 20 if rule else 0
    height = leading * (len(lines) - 1) + size * 1.3
    for scheme, (fg, amber) in COLORS.items():
        parts = []
        for i, (t, (_, w)) in enumerate(zip(lines, measured)):
            x = pad + lead_in + ((width - w) / 2 if align == "center" else 0)
            baseline = size + i * leading
            paths, _ = line_paths(font, t, size, x, baseline)
            parts.append(f'<path fill="{fg}" d="{" ".join(paths)}"/>')
        if rule: parts.append(f'<circle cx="{pad + 5}" cy="{size * 0.64:.1f}" r="4" fill="{amber}"/>')
        W = width + pad * 2 + lead_in
        doc = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{height:.0f}" viewBox="0 0 {W:.1f} {height:.1f}" role="img" aria-label="{" ".join(lines)}">{"".join(parts)}</svg>'
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{name}.{scheme}.svg").write_text(doc)

# 定义行：两行，居中，衬线
svg("zh-intro", ["Quetzal 是开源的 agent 运行基座。", "让一个 AI 住进你的旧手机，记得你说过的话，自己醒来，困了就睡。"], SERIF, 28, 44, "center")
svg("en-intro", ["Quetzal is an open-source runtime for agents.", "An AI moves into your old phone, remembers what you say, and wakes on its own."], SERIF, 28, 44, "center")
# 小节标题：衬线，左侧一段琥珀线
HEADINGS = {
  "zh": {"what": "它是什么", "month": "一个月后", "day": "一天", "neighbors": "和 Hermes / OpenClaw 的关系", "how": "它是怎么做到的", "trust": "托付之前", "install": "装上它", "deeper": "看得更深"},
  "en": {"what": "What it is", "month": "A month in", "day": "One day", "neighbors": "Hermes / OpenClaw and Quetzal", "how": "How it works", "trust": "Before you trust it", "install": "Install", "deeper": "Go deeper"},
}
for lang, hs in HEADINGS.items():
    for key, text in hs.items(): svg(f"{lang}-{key}", [text], SERIF, 26, 0, rule=True)
print("写入", OUT, len(list(OUT.glob("*.svg"))), "个文件")
