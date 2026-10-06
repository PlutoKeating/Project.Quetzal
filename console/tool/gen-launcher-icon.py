#!/usr/bin/env python3
"""生成控制台的启动图标：与首页光团同一套渲染（主题色提高饱和度与亮度后的实心球：左上光源、HSL 明度偏移、
白色高光点、宽光晕），颜色取自官网设计系统的琥珀 accent #F0A35E。

输出（均入库）：
  android/app/src/main/res/mipmap-*/ic_launcher.png             传统图标（Android 7 及以下整图显示）
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png  自适应图标前景（Android 8+，108dp，球在中央安全区）
  android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml    自适应图标：前景 + 背景色 #202020
  android/app/src/main/res/values/ic_launcher_background.xml
  windows/runner/resources/app_icon.ico                        Windows 桌面版的程序图标（16–256，每个尺寸单独渲染，透明底）
  assets/tray/icon.ico                                          Windows 托盘图标（由 assets/tray/icon.png 缩放，与 Linux 托盘同一个球）
用法：python3 tool/gen-launcher-icon.py   依赖 Pillow、numpy。"""
import colorsys, os
import numpy as np
from PIL import Image

ACCENT, BG = "#F0A35E", "#202020"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
SS = 4  # 超采样倍数

def hx(h): return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
def vivid(hex_):  # 与 widgets.dart 的 Orb 一致：饱和度 ×1.3、明度 +0.06
    h, l, s = colorsys.rgb_to_hls(*hx(hex_)); return h, min(1, l + .06), min(1, s * 1.3)
def lit(hls, d): h, l, s = hls; return np.array(colorsys.hls_to_rgb(h, min(1, max(0, l + d)), s))

def ramp(t, stops):  # t: 数组；stops: [(位置, 颜色向量)]，线性插值
    out = np.zeros(t.shape + (stops[0][1].shape[0],))
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        m = (t >= p0) & (t <= p1); k = ((t[m] - p0) / (p1 - p0))[:, None]; out[m] = c0 * (1 - k) + c1 * k
    out[t > stops[-1][0]] = stops[-1][1]; return out

def render(size, r_frac, bg=None):
    """size: 输出像素；r_frac: 球半径占画布边长的比例；bg: 背景色（None 为透明）。返回 RGBA 图。"""
    n = size * SS; c = n / 2; r = n * r_frac
    hls = vivid(ACCENT); body, hi, mid, rim = lit(hls, 0), lit(hls, .28), lit(hls, .12), lit(hls, -.225)
    yy, xx = np.mgrid[0:n, 0:n] + .5
    rgb = np.zeros((n, n, 3)); a = np.zeros((n, n))
    if bg: rgb[:] = hx(bg); a[:] = 1
    # 光晕：半径 2.2r，透明度 0.64 → 0.19（55%）→ 0，颜色为球体色（与 Orb 的 alert≈0.5 时一致）
    d = np.hypot(xx - c, yy - c); t = np.clip(d / (2.2 * r), 0, 1)
    ga = ramp(t, [(0, np.array([.64])), (.55, np.array([.19])), (1, np.array([0.]))])[..., 0]
    rgb = rgb * (1 - ga[..., None]) + body * ga[..., None]; a = a + ga * (1 - a)
    # 球体：光源在左上 0.38r，半径 1.38r，明度 +0.28 → +0.12 → 0 → -0.225
    inside = np.clip(r + .5 - d, 0, 1)  # 边缘抗锯齿
    ds = np.hypot(xx - (c - .38 * r), yy - (c - .38 * r)); ts = np.clip(ds / (1.38 * r), 0, 1)
    sph = ramp(ts, [(0, hi), (.25, mid), (.6, body), (1, rim)])
    rgb = rgb * (1 - inside[..., None]) + sph * inside[..., None]; a = a + inside * (1 - a)
    # 高光点：-0.42r 处，半径 0.2r，白 0.95 → 0
    dh = np.hypot(xx - (c - .42 * r), yy - (c - .42 * r)); ha = np.clip(1 - dh / (.2 * r), 0, 1) * .95 * inside
    rgb = rgb * (1 - ha[..., None]) + np.array([1., 1, 1]) * ha[..., None]
    # 以上按预乘 alpha 叠加；PNG 存直通 alpha，所以这里反预乘
    rgb = np.where(a[..., None] > 1e-6, rgb / np.maximum(a, 1e-6)[..., None], 0)
    img = np.dstack([np.clip(rgb, 0, 1) * 255, np.clip(a, 0, 1) * 255]).astype(np.uint8)
    return Image.fromarray(img, "RGBA").resize((size, size), Image.LANCZOS)

res = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main", "res")
for name, k in DENSITIES.items():
    d = os.path.join(res, f"mipmap-{name}"); os.makedirs(d, exist_ok=True)
    render(int(48 * k), .30).save(os.path.join(d, "ic_launcher.png"), optimize=True)           # 传统：球占 60%，光晕到边
    render(int(108 * k), .21).save(os.path.join(d, "ic_launcher_foreground.png"), optimize=True)  # 自适应：球直径 45dp，在 66dp 安全区内
os.makedirs(os.path.join(res, "mipmap-anydpi-v26"), exist_ok=True)
open(os.path.join(res, "mipmap-anydpi-v26", "ic_launcher.xml"), "w").write(
    '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n</adaptive-icon>\n')
open(os.path.join(res, "values", "ic_launcher_background.xml"), "w").write(
    f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">{BG}</color>\n</resources>\n')
render(512, .30, BG).save(os.path.join(os.path.dirname(__file__), "..", "..", "docs", "assets", "readme", "app-icon.png"), optimize=True)  # 商店 / 文档用的 512 预览
here = os.path.dirname(__file__)
ico = [render(n, .30) for n in (256, 64, 48, 32, 24, 16)]  # Windows：程序图标（资源管理器、任务栏、Alt-Tab），小尺寸单独渲染才清楚
ico[0].save(os.path.join(here, "..", "windows", "runner", "resources", "app_icon.ico"), sizes=[im.size for im in ico], append_images=ico[1:])
tray = Image.open(os.path.join(here, "..", "assets", "tray", "icon.png")).convert("RGBA")  # Windows 托盘要 .ico：与 Linux 托盘同一张图
tray.save(os.path.join(here, "..", "assets", "tray", "icon.ico"), sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64)])
print("已生成启动图标：5 个密度的传统图标与自适应前景、mipmap-anydpi-v26/ic_launcher.xml、values/ic_launcher_background.xml、docs/assets/readme/app-icon.png、windows/runner/resources/app_icon.ico、assets/tray/icon.ico")
