// 安卓：没有页面来源，也没有 URL。
import 'dart:async';

/// 页面的来源（http://127.0.0.1:7788）。安卓为 null。
String? get pageOrigin => null;
String get hash => '';
set hash(String v) {}
Stream<String> get hashChanges => const Stream.empty();
void setTitle(String title) {}
void claimUrl() {}
