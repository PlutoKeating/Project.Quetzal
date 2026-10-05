// 网关的加密连接：证书指纹的钉住、配对证明、网关地址的写法。
//   运行基座对局域网只开 HTTPS / WSS（自签名证书，默认端口 7789），明文 HTTP 只在本机回环（7788）。
//   控制台不靠 CA，而是钉住证书指纹：SHA-256（证书 DER）的小写十六进制，按 host:port 记在连接档案里（Profile.fp）。
//   配对时先「捕获」：只对这一个 host:port 接受任何证书并记下指纹（/pair/info），给人核对后钉住；
//   配对证明 proof = hex(PBKDF2-HMAC-SHA256(配对码, "quetzal-pair-v2|" + 指纹, 100000, 32 字节))，配对码不上网络，
//   中间人看到的是自己的证书，它转给运行基座的证明对不上。钉住的检查在 platform/pin_io.dart（HttpOverrides，覆盖 HTTP、WebSocket 与 Image.network）。
import 'dart:convert';
import 'package:crypto/crypto.dart' as hash;
import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

const pairSalt = 'quetzal-pair-v2|';
const pairIterations = 100000;
const defaultPort = 7788, defaultLanPort = 7789;

/// 配对码的写法：大小写、空格与连字符不计。
String normCode(String c) => c.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');

/// 证书指纹：SHA-256（DER）的小写十六进制。
String fingerprintOf(List<int> der) => hash.sha256.convert(der).toString();

/// 短格式：前 16 位，4 位一组（「1a2b 3c4d 5e6f 7a8b」），与配对通知里的一致。
String shortFingerprint(String fp) => fp.length < 16 ? fp : [for (var i = 0; i < 16; i += 4) fp.substring(i, i + 4)].join(' ');

Future<String> _proof((String, String) a) async {
  final k = await Pbkdf2(macAlgorithm: Hmac.sha256(), iterations: pairIterations, bits: 256)
      .deriveKeyFromPassword(password: a.$1, nonce: utf8.encode('$pairSalt${a.$2}'));
  return (await k.extractBytes()).map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

/// 配对证明。10 万次迭代在手机上要几百毫秒：原生平台放到后台 isolate 里算（网页版用浏览器的 WebCrypto，本来就不卡界面）。
Future<String> pairProof(String code, String fingerprint) => compute(_proof, (normCode(code), fingerprint.toLowerCase()));

bool isLoopback(String host) => const {'127.0.0.1', 'localhost', '::1', '[::1]'}.contains(host.toLowerCase());

/// 把人填的网关地址规范成 base：只填地址（IP 或名字，可带端口）时，本机回环用 http://…:7788，别的机器用 https://…:7789；
/// 填了 http:// 的别的机器（旧写法）换成 https，端口 7788 或没写时换成 7789；https:// 没写端口时补 7789。返回 null 表示写法不对。
String? normalizeBase(String input) {
  var s = input.trim().replaceAll(RegExp(r'/+$'), '');
  if (s.isEmpty) return null;
  final hasScheme = RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*://').hasMatch(s);
  final u = Uri.tryParse(hasScheme ? s : 'x://$s');
  if (u == null || u.host.isEmpty || (hasScheme && u.scheme != 'http' && u.scheme != 'https')) return null;
  if (u.path.isNotEmpty || u.hasQuery || u.hasFragment || u.userInfo.isNotEmpty) return null;
  final host = u.host.contains(':') ? '[${u.host}]' : u.host;
  final explicit = RegExp(r':\d+$').hasMatch(s) ? u.port : null;
  if (isLoopback(u.host) && (!hasScheme || u.scheme == 'http')) return 'http://$host:${explicit ?? defaultPort}';
  final port = explicit == null || (u.scheme == 'http' && explicit == defaultPort) ? defaultLanPort : explicit;
  return 'https://$host:$port';
}

/// 旧的明文局域网地址（http:// 到别的机器）：新的运行基座不再在局域网上提供明文，需要重新配对。
bool isLegacyLan(String base) {
  final u = Uri.tryParse(base);
  return u != null && u.scheme == 'http' && !isLoopback(u.host);
}

/// 钉住的指纹（host:port → 指纹）与配对时的捕获。只是数据，平台层据此判定证书。
class Pins {
  final _pinned = <String, String>{};
  final _capturing = <String>{};
  final _captured = <String, String>{};

  static String key(String host, int port) => '${host.toLowerCase().replaceAll(RegExp(r'^\[|\]$'), '')}:$port';

  /// 用连接档案的 (base, fp) 重建（只收 https 且指纹合法的）。
  void load(Iterable<(String, String)> entries) {
    _pinned.clear();
    for (final (base, fp) in entries) {
      final u = Uri.tryParse(base);
      if (u != null && u.scheme == 'https' && RegExp(r'^[0-9a-f]{64}$').hasMatch(fp)) _pinned[key(u.host, u.port)] = fp;
    }
  }

  void pin(String host, int port, String fp) => _pinned[key(host, port)] = fp.toLowerCase();
  String? pinned(String host, int port) => _pinned[key(host, port)];

  /// 这个 host:port 由钉住（或捕获）管：连接时不用系统的 CA，只按指纹判定。
  bool handles(String host, int port) => _pinned.containsKey(key(host, port)) || _capturing.contains(key(host, port));

  /// 捕获：接下来对这个 host:port 接受任何证书并记下指纹（只在配对的第一步用，指纹随后给人核对、并绑进配对证明）。
  void startCapture(String host, int port) { _capturing.add(key(host, port)); _captured.remove(key(host, port)); }
  String? endCapture(String host, int port) { _capturing.remove(key(host, port)); return _captured.remove(key(host, port)); }

  /// TLS 握手时的判定：捕获中的记下并接受；否则指纹必须等于钉住的。
  bool accept(String host, int port, List<int> der) {
    final k = key(host, port), fp = fingerprintOf(der);
    if (_capturing.contains(k)) { _captured[k] = fp; return true; }
    final want = _pinned[k];
    return want != null && want == fp;
  }
}

final pins = Pins();
