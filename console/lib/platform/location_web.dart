// 浏览器：来源、#片段与标题。
import 'dart:async';
import 'dart:js_interop';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:web/web.dart' as web;

/// 让 Flutter 不再改写 URL（它默认会把 #片段写成自己的路由 #/），#片段交给 Nav 管理。runApp 之前调用。
void claimUrl() => setUrlStrategy(null);

String? get pageOrigin => web.window.location.origin;
String get hash => web.window.location.hash;
set hash(String v) { if (web.window.location.hash != v) web.window.location.hash = v; }

StreamController<String>? _hashes;
Stream<String> get hashChanges {
  if (_hashes == null) {
    _hashes = StreamController<String>.broadcast();
    web.window.addEventListener('hashchange', ((web.Event _) => _hashes!.add(web.window.location.hash)).toJS);
  }
  return _hashes!.stream;
}
void setTitle(String title) => web.document.title = title;
