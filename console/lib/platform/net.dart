// HTTP：探活、配对、本机登录、上传。安卓用 dart:io；网页用浏览器的 XMLHttpRequest（能报告上传进度）。
export 'net_io.dart' if (dart.library.js_interop) 'net_web.dart';

class HttpReply {
  final int status;
  final String body;
  const HttpReply(this.status, this.body);
}
