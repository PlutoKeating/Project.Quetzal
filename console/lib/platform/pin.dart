// 证书钉住的安装：原生平台用 HttpOverrides 接管所有 HttpClient（网关请求、WebSocket、Image.network 都经过它）；网页版由浏览器处理 TLS，什么都不做。
export 'pin_io.dart' if (dart.library.js_interop) 'pin_web.dart';
