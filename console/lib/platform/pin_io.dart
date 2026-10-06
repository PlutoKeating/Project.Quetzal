// 原生平台（安卓、Linux / Windows 桌面）：HttpOverrides 接管所有 HttpClient。
//   钉住或正在捕获的 host:port（pins.handles）：直连（不走代理），TLS 上下文不带系统 CA，每张证书都交给 pins.accept 按指纹判定——
//   这样即使有人拿到这个名字的 CA 签发证书也替换不了。其他地址（GitHub、官网等）照常用系统 CA，不受影响。
import 'dart:io';
import '../pins.dart';

class PinnedHttpOverrides extends HttpOverrides {
  final Pins store;
  PinnedHttpOverrides(this.store);

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final c = super.createHttpClient(context);
    c.badCertificateCallback = (cert, host, port) => store.handles(host, port) && store.accept(host, port, cert.der);
    c.findProxy = (uri) => store.handles(uri.host, uri.port) ? 'DIRECT' : HttpClient.findProxyFromEnvironment(uri);
    c.connectionFactory = (uri, proxyHost, proxyPort) {
      if (proxyHost != null) return Socket.startConnect(proxyHost, proxyPort!); // 走代理：隧道里的 TLS 由 HttpClient 用上面的回调判定
      if (!uri.isScheme('https')) return Socket.startConnect(uri.host, uri.port);
      if (store.handles(uri.host, uri.port)) {
        return SecureSocket.startConnect(uri.host, uri.port, context: SecurityContext(withTrustedRoots: false), onBadCertificate: (cert) => store.accept(uri.host, uri.port, cert.der));
      }
      return SecureSocket.startConnect(uri.host, uri.port, context: context);
    };
    return c;
  }
}

void installPinning() => HttpOverrides.global = PinnedHttpOverrides(pins);
