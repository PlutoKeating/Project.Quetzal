// 浏览器实现（网页版）：XMLHttpRequest，上传用 upload.onprogress 报告进度。
import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';
import 'package:web/web.dart' as web;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'net.dart';

/// 连接网关的 WebSocket（浏览器自己处理 wss 的证书）。
WebSocketChannel wsConnect(Uri url) => WebSocketChannel.connect(url);

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

/// 上传：按「无进展」计时——上传或下载有进度就重新计时，60 秒没有任何进度才放弃（大文件还在传就不砍）。
Future<HttpReply> upload(String url, Uint8List bytes, {Map<String, String> headers = const {}, void Function(double)? onProgress}) {
  final xhr = web.XMLHttpRequest()..open('POST', url);
  headers.forEach((k, v) => xhr.setRequestHeader(k, v));
  Timer? t;
  void arm() { t?.cancel(); t = Timer(const Duration(seconds: 60), () => xhr.abort()); }
  xhr.upload.addEventListener('progress', ((web.ProgressEvent e) { arm(); if (onProgress != null && e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); }).toJS);
  xhr.addEventListener('progress', ((web.Event _) => arm()).toJS);
  arm();
  return _send(xhr, bytes.toJS).whenComplete(() => t?.cancel());
}
