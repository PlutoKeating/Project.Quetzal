// 浏览器实现（网页版）：XMLHttpRequest，上传用 upload.onprogress 报告进度。
import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';
import 'package:web/web.dart' as web;
import 'net.dart';

Future<HttpReply> _send(web.XMLHttpRequest xhr, JSAny? body) {
  final c = Completer<HttpReply>();
  xhr.addEventListener('load', ((web.Event _) { if (!c.isCompleted) c.complete(HttpReply(xhr.status, xhr.responseText)); }).toJS);
  xhr.addEventListener('error', ((web.Event _) { if (!c.isCompleted) c.completeError(Exception('网络错误：连不上 ${xhr.responseURL}')); }).toJS);
  xhr.addEventListener('timeout', ((web.Event _) { if (!c.isCompleted) c.completeError(TimeoutException('请求超时')); }).toJS);
  xhr.addEventListener('abort', ((web.Event _) { if (!c.isCompleted) c.completeError(Exception('请求被取消')); }).toJS);
  xhr.send(body);
  return c.future;
}

Future<HttpReply> request(String method, String url, {String? json, Map<String, String> headers = const {}, Duration timeout = const Duration(seconds: 8)}) {
  final xhr = web.XMLHttpRequest()..open(method, url)..timeout = timeout.inMilliseconds;
  headers.forEach((k, v) => xhr.setRequestHeader(k, v));
  if (json != null) xhr.setRequestHeader('content-type', 'application/json');
  return _send(xhr, json?.toJS);
}

Future<HttpReply> upload(String url, Uint8List bytes, {Map<String, String> headers = const {}, void Function(double)? onProgress}) {
  final xhr = web.XMLHttpRequest()..open('POST', url)..timeout = const Duration(minutes: 5).inMilliseconds;
  headers.forEach((k, v) => xhr.setRequestHeader(k, v));
  if (onProgress != null) {
    xhr.upload.addEventListener('progress', ((web.ProgressEvent e) { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); }).toJS);
  }
  return _send(xhr, bytes.toJS);
}
