#!/usr/bin/env python3
# 生成网页版控制台用的中文字体子集：web/fonts/NotoSansCJKsc-subset.otf。
#   Flutter Web（CanvasKit）不能用系统字体，缺字时会去 fonts.gstatic.com 下载 Noto——离线或在中国大陆会变成方块。
#   所以网页版在启动时从网关加载这份自带的子集（见 lib/platform/fonts_web.dart），不进 pubspec 的 fonts（APK 不需要，安卓用系统字体）。
#   字符集：ASCII 与拉丁补充、通用标点、CJK 标点与全角、GB2312 全部汉字与符号（6763 字），约 3 MB（CFF）。
#   来源：系统的 Noto Sans CJK（OFL 1.1，fonts-noto-cjk），用 fontTools 子集化。重新生成：python3 tool/gen-cjk-font.py
import sys
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTCollection

SRC = Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
OUT = Path(__file__).resolve().parent.parent / 'web' / 'fonts' / 'NotoSansCJKsc-subset.otf'

def codepoints():
    cps = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100))           # ASCII、Latin-1
    cps |= set(range(0x2000, 0x2070)) | set(range(0x2190, 0x2200))     # 通用标点、箭头
    cps |= set(range(0x2500, 0x2600)) | set(range(0x25A0, 0x2600))     # 制表符、几何图形
    cps |= set(range(0x3000, 0x3040)) | set(range(0xFF00, 0xFFF0))     # CJK 标点、全角
    for hi in range(0xA1, 0xF8):                                       # GB2312：区位码扫描
        for lo in range(0xA1, 0xFF):
            try: cps.add(ord(bytes([hi, lo]).decode('gb2312')))
            except (UnicodeDecodeError, TypeError): pass
    return cps

def main():
    if not SRC.exists(): sys.exit(f'找不到 {SRC}：请安装 fonts-noto-cjk')
    index = next(i for i, f in enumerate(TTCollection(str(SRC)).fonts) if f['name'].getDebugName(1) == 'Noto Sans CJK SC')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cps = codepoints()
    subset.main([str(SRC), f'--font-number={index}', f'--unicodes={",".join(f"U+{c:04X}" for c in sorted(cps))}',
                 '--layout-features=*', '--no-hinting', '--desubroutinize', '--name-IDs=*', f'--output-file={OUT}'])
    print(f'{OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT}：{len(cps)} 个码位，{OUT.stat().st_size / 1048576:.1f} MB')

if __name__ == '__main__': main()
