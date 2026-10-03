#!/usr/bin/env python3
"""生成品牌图片：官网分享图 public/og.png（1200×630）与仓库 README 横幅 ../docs/assets/readme/banner.png（1600×560）。
颜色取自 designSystem.ts 的深色方案（手动同步：bg、fg、fg-muted、accent）。
用法：python3 scripts/gen-brand-images.py <Inter-SemiBold.ttf> <Inter-Regular.ttf> [NotoSansCJK.ttc]
依赖 Pillow。字体文件不入库（Inter 见 public/fonts/LICENSE-Inter.txt；CJK 用系统 Noto Sans CJK）。"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG, FG, MUTED, ACCENT = "#0e0f11", "#e8e4dd", "#a9a49c", "#f0a35e"
semibold, regular = sys.argv[1], sys.argv[2]
cjk = sys.argv[3] if len(sys.argv) > 3 else None
SLOGAN = ("Not running. Living.", "Living like wind.")
ZH = "不是在运行，是在活着。像风一样活着。"
SITE = "windler.plutokeating.beer"

def canvas(w, h, glow_box):
    img = Image.new("RGB", (w, h), BG)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(glow_box, fill=(240, 163, 94, 70))
    img.paste(glow.filter(ImageFilter.GaussianBlur(110)), (0, 0), glow.filter(ImageFilter.GaussianBlur(110)))
    return img

def lamp(d, x, y, r=11):
    d.ellipse((x - r, y - r, x + r, y + r), fill=ACCENT)

# 1) 分享图
img = canvas(1200, 630, (760, -140, 1260, 360)); d = ImageDraw.Draw(img)
lamp(d, 107, 107); d.text((134, 86), "Windler", font=ImageFont.truetype(semibold, 40), fill=FG)
d.text((96, 190), SLOGAN[0], font=ImageFont.truetype(semibold, 76), fill=FG)
d.text((96, 280), SLOGAN[1], font=ImageFont.truetype(semibold, 76), fill=FG)
if cjk: d.text((96, 390), ZH, font=ImageFont.truetype(cjk, 40, index=0), fill=MUTED)
d.text((96, 476), "A general-purpose runtime for agentic life. Runs on an old phone.", font=ImageFont.truetype(regular, 26), fill=MUTED)
d.text((96, 540), SITE, font=ImageFont.truetype(regular, 24), fill=ACCENT)
img.save("public/og.png", optimize=True); print("public/og.png")

# 2) README 横幅：更宽，右侧留给光斑，底部一枚「官网」胶囊
img = canvas(1600, 560, (1060, -160, 1700, 480)); d = ImageDraw.Draw(img)
lamp(d, 123, 113, 12); d.text((152, 90), "Windler", font=ImageFont.truetype(semibold, 44), fill=FG)
d.text((112, 190), SLOGAN[0], font=ImageFont.truetype(semibold, 84), fill=FG)
d.text((112, 288), SLOGAN[1], font=ImageFont.truetype(semibold, 84), fill=FG)
if cjk: d.text((112, 404), ZH, font=ImageFont.truetype(cjk, 38, index=0), fill=MUTED)
pill_font = ImageFont.truetype(semibold, 26)
label = f"{SITE}  →"
tw = d.textlength(label, font=pill_font)
x0, y0 = 112, 470
d.rounded_rectangle((x0, y0, x0 + tw + 56, y0 + 56), radius=28, fill=ACCENT)
d.text((x0 + 28, y0 + 13), label, font=pill_font, fill="#1a120a")
img.save("../docs/assets/readme/banner.png", optimize=True); print("docs/assets/readme/banner.png")
