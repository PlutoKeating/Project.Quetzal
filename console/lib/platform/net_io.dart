// dart:io 实现（安卓、Linux 桌面）。HttpClient 都经过 pin_io.dart 的 HttpOverrides：钉住的网关只认它的证书指纹。
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'net.dart';

/// 连接网关的 WebSocket：明确交给一个 HttpClient()（经过钉住的 HttpOverrides），wss 同样只认钉住的证书。
WebSocketChannel wsConnect(Uri url) => IOWebSocketChannel.connect(url, customClient: HttpClient()..connectionTimeout = const Duration(seconds: 8));

Future<HttpReply> request(String method, String url, {String? json, Map<String, String> headers = const {}, Duration timeout = const Duration(seconds: 8)}) async {
  final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
  try {
    final req = await c.openUrl(method, Uri.parse(url));
    headers.forEach(req.headers.set);
    if (json != null) { req.headers.contentType = ContentType.json; req.write(json); }
    final res = await req.close().timeout(timeout);
    return HttpReply(res.statusCode, await res.transform(utf8.decoder).join());
  } finally { c.close(); }
}

Future<HttpReply> upload(String url, Uint8List bytes, {Map<String, String> headers = const {}, void Function(double)? onProgress}) async {
  final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
  try {
    final req = await c.postUrl(Uri.parse(url));
    headers.forEach(req.headers.set);
    req.contentLength = bytes.length;
    var sent = 0;
    const chunk = 64 * 1024;
    for (var i = 0; i < bytes.length; i += chunk) {
      final part = bytes.sublist(i, i + chunk > bytes.length ? bytes.length : i + chunk);
      req.add(part);
      await req.flush();
      sent += part.length;
      onProgress?.call(bytes.isEmpty ? 1 : sent / bytes.length);
    }
    final res = await req.close().timeout(const Duration(minutes: 5));
    return HttpReply(res.statusCode, await res.transform(utf8.decoder).join());
  } finally { c.close(); }
}
