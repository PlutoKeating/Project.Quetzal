#!/usr/bin/env python3
"""生成品牌图片：官网分享图 public/og.png（1200×630）与仓库 README 横幅 ../docs/assets/readme/banner.png（1600×680）。
颜色取自 designSystem.ts 的深色方案（手动同步：bg、fg、fg-muted、accent、orb-*）。
标志是光团：与 OrbMark、favicon、控制台图标同一颗球（左上光源、明度偏移、高光点、光晕）。
用法：python3 scripts/gen-brand-images.py <Inter-SemiBold.ttf> <Inter-Regular.ttf> [NotoSansCJK.ttc]（ttc 里取简体中文那一面，CJK_INDEX）
依赖 Pillow、numpy。字体文件不入库（Inter 见 public/fonts/LICENSE-Inter.txt；静态实例可用 fontTools 从 public/fonts/InterVariable.woff2
生成：instancer.instantiateVariableFont(font, {"wght": 600})；CJK 用系统 Noto Sans CJK）。"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG, FG, MUTED, ACCENT = "#0e0f11", "#e8e4dd", "#a9a49c", "#f0a35e"
semibold, regular = sys.argv[1], sys.argv[2]
cjk = sys.argv[3] if len(sys.argv) > 3 else None
SLOGAN = ("Not running, but living.", "Living like wind.")
ZH = ("不是运行着，是活着。", "活成一缕风。")
SITE = "quetzal.plutokeating.beer"
CJK_INDEX = 2  # 系统 NotoSansCJK-Regular.ttc 的第 2 面是 Noto Sans CJK SC

def canvas(w, h, glow_box):
    img = Image.new("RGB", (w, h), BG)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(glow_box, fill=(240, 163, 94, 70))
    img.paste(glow.filter(ImageFilter.GaussianBlur(110)), (0, 0), glow.filter(ImageFilter.GaussianBlur(110)))
    return img

ORB_HI, ORB_MID, ORB, ORB_RIM = "#fffefc", "#ffd3ab", "#ffb26e", "#fa7600"  # designSystem 的 orb-* 色标

def _hx(h): return np.array([int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)])
def _ramp(t, stops):
    out = np.zeros(t.shape + (len(stops[0][1]),))
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        m = (t >= p0) & (t <= p1); k = ((t[m] - p0) / (p1 - p0))[:, None]; out[m] = c0 * (1 - k) + c1 * k
    out[t > stops[-1][0]] = stops[-1][1]; return out

def lamp(img, x, y, r=11, ss=4):
    """在 img 的 (x, y) 处画一颗半径 r 的光团：光晕 2.2r（0.64 → 0.19 → 0）、球体以左上 0.38r 为光源半径 1.38r、白高光点 -0.42r 半径 0.2r。"""
    R = int(r * 2.2) + 2; n = R * 2 * ss; c = n / 2; rr = r * ss
    yy, xx = np.mgrid[0:n, 0:n] + .5
    d = np.hypot(xx - c, yy - c)
    ga = _ramp(np.clip(d / (2.2 * rr), 0, 1), [(0, np.array([.64])), (.55, np.array([.19])), (1, np.array([0.]))])[..., 0]
    rgb = _hx(ORB) * ga[..., None]; a = ga.copy()
    inside = np.clip(rr + .5 - d, 0, 1)
    ts = np.clip(np.hypot(xx - (c - .38 * rr), yy - (c - .38 * rr)) / (1.38 * rr), 0, 1)
    sph = _ramp(ts, [(0, _hx(ORB_HI)), (.25, _hx(ORB_MID)), (.6, _hx(ORB)), (1, _hx(ORB_RIM))])
    rgb = rgb * (1 - inside[..., None]) + sph * inside[..., None]; a = a + inside * (1 - a)
    ha = np.clip(1 - np.hypot(xx - (c - .42 * rr), yy - (c - .42 * rr)) / (.2 * rr), 0, 1) * .95 * inside
    rgb = rgb * (1 - ha[..., None]) + ha[..., None]
    rgb = np.where(a[..., None] > 1e-6, rgb / np.maximum(a, 1e-6)[..., None], 0)
    layer = Image.fromarray(np.dstack([np.clip(rgb, 0, 1) * 255, np.clip(a, 0, 1) * 255]).astype(np.uint8), "RGBA").resize((R * 2, R * 2), Image.LANCZOS)
    img.paste(layer, (int(x - R), int(y - R)), layer)

# 1) 分享图
img = canvas(1200, 630, (760, -140, 1260, 360)); d = ImageDraw.Draw(img)
lamp(img, 107, 95, 13); d.text((134, 74), "Quetzal", font=ImageFont.truetype(semibold, 40), fill=FG)
d.text((96, 166), SLOGAN[0], font=ImageFont.truetype(semibold, 72), fill=FG)
d.text((96, 252), SLOGAN[1], font=ImageFont.truetype(semibold, 72), fill=FG)
if cjk:
    zf = ImageFont.truetype(cjk, 32, index=CJK_INDEX)
    d.text((96, 376), ZH[0], font=zf, fill=MUTED); d.text((96, 420), ZH[1], font=zf, fill=MUTED)
d.text((96, 500), "An open-source runtime for agents. Runs on an old phone.", font=ImageFont.truetype(regular, 26), fill=MUTED)
d.text((96, 560), SITE, font=ImageFont.truetype(regular, 24), fill=ACCENT)
img.save("public/og.png", optimize=True); print("public/og.png")

# 2) README 横幅：更宽，右侧留给光斑，底部一枚「官网」胶囊
# 1600×680：上下各 ~90 的边距，标语、中文、胶囊之间留出整段呼吸
img = canvas(1600, 680, (1060, -160, 1700, 560)); d = ImageDraw.Draw(img)
lamp(img, 123, 109, 14); d.text((152, 86), "Quetzal", font=ImageFont.truetype(semibold, 44), fill=FG)
d.text((112, 196), SLOGAN[0], font=ImageFont.truetype(semibold, 80), fill=FG)
d.text((112, 292), SLOGAN[1], font=ImageFont.truetype(semibold, 80), fill=FG)
if cjk:
    zf = ImageFont.truetype(cjk, 32, index=CJK_INDEX)
    d.text((112, 430), ZH[0], font=zf, fill=MUTED); d.text((112, 476), ZH[1], font=zf, fill=MUTED)
pill_font = ImageFont.truetype(semibold, 26)
label = f"{SITE}  →"
tw = d.textlength(label, font=pill_font)
x0, y0 = 112, 564
d.rounded_rectangle((x0, y0, x0 + tw + 56, y0 + 56), radius=28, fill=ACCENT)
d.text((x0 + 28, y0 + 13), label, font=pill_font, fill="#1a120a")
img.save("../docs/assets/readme/banner.png", optimize=True); print("docs/assets/readme/banner.png")
