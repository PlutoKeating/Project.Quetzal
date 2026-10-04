import 'dart:js_interop';
import 'package:flutter/services.dart';
import 'package:web/web.dart' as web;

const _family = 'QuetzalCJK';
bool _loaded = false;
String? get fontFamily => _loaded ? _family : null;

/// 加载自带的中文字体子集（约 3 MB，浏览器会缓存）。失败就用引擎的回退字体，不阻塞启动。
Future<void> loadFonts() async {
  try {
    final r = await web.window.fetch('fonts/NotoSansCJKsc-subset.otf'.toJS).toDart;
    if (!r.ok) return;
    final buf = (await r.arrayBuffer().toDart).toDart;
    await (FontLoader(_family)..addFont(Future.value(ByteData.view(buf)))).load();
    _loaded = true;
  } catch (_) {}
}
