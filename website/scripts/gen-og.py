#!/usr/bin/env python3
"""生成分享图 public/og.png（1200×630）。颜色取自 designSystem.ts 的深色方案（手动同步：bg、fg、fg-muted、accent）。
用法：python3 scripts/gen-og.py <Inter-SemiBold.ttf> <Inter-Regular.ttf> [NotoSansCJK.ttc]
依赖 Pillow。字体文件不入库（Inter 见 public/fonts/LICENSE-Inter.txt；CJK 用系统 Noto Sans CJK）。"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG, FG, MUTED, ACCENT = "#0e0f11", "#e8e4dd", "#a9a49c", "#f0a35e"
W, H = 1200, 630
semibold, regular = sys.argv[1], sys.argv[2]
cjk = sys.argv[3] if len(sys.argv) > 3 else None

img = Image.new("RGB", (W, H), BG)
# 呼吸光斑：右上角的柔光
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
g = ImageDraw.Draw(glow)
g.ellipse((760, -140, 1260, 360), fill=(240, 163, 94, 70))
glow = glow.filter(ImageFilter.GaussianBlur(110))
img.paste(glow, (0, 0), glow)

d = ImageDraw.Draw(img)
d.ellipse((96, 96, 118, 118), fill=ACCENT)  # 一盏小灯
d.text((134, 86), "Windler", font=ImageFont.truetype(semibold, 40), fill=FG)
d.text((96, 190), "Not running. Living.", font=ImageFont.truetype(semibold, 76), fill=FG)
d.text((96, 280), "Living like wind.", font=ImageFont.truetype(semibold, 76), fill=FG)
if cjk:
    d.text((96, 390), "ta 不是在运行，ta 是在活着。", font=ImageFont.truetype(cjk, 40, index=0), fill=MUTED)
d.text((96, 476), "A general-purpose runtime for agentic life. Runs on an old phone.", font=ImageFont.truetype(regular, 26), fill=MUTED)
d.text((96, 540), "windler.plutokeating.beer", font=ImageFont.truetype(regular, 24), fill=ACCENT)
img.save("public/og.png", optimize=True)
print("public/og.png 已生成")
