// dart:io 实现（安卓）。
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'net.dart';

Future<HttpReply> request(String method, String url, {String? json, Duration timeout = const Duration(seconds: 8)}) async {
  final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
  try {
    final req = await c.openUrl(method, Uri.parse(url));
    if (json != null) { req.headers.contentType = ContentType.json; req.write(json); }
    final res = await req.close().timeout(timeout);
    return HttpReply(res.statusCode, await res.transform(utf8.decoder).join());
  } finally { c.close(); }
}

Future<HttpReply> upload(String url, Uint8List bytes, {void Function(double)? onProgress}) async {
  final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
  try {
    final req = await c.postUrl(Uri.parse(url));
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
