// 字体：网页版（CanvasKit）用不了系统字体，缺字时会去 Google 下载 Noto，离线或在中国大陆会变成方块；
// 所以网页版启动时从网关加载自带的中文子集（web/fonts/，tool/gen-cjk-font.py 生成）。安卓用系统字体，什么都不做。
export 'fonts_io.dart' if (dart.library.js_interop) 'fonts_web.dart';
