// 加密连接：配对证明（与运行基座 Node 实现的已知向量核对）、网关地址的写法、证书指纹的钉住与捕获（真实的 TLS 握手）、加密配对的完整流程。
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/pins.dart';
import 'package:quetzal_console/platform/net.dart' as net;
import 'package:quetzal_console/platform/pin_io.dart';

/// 用 openssl 生成一张自签名证书（ECDSA P-256），返回 (证书 PEM, 私钥 PEM, 指纹)。没有 openssl 时返回 null。
Future<(String, String, String)?> selfSigned(Directory dir) async {
  try {
    final r = await Process.run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', '${dir.path}/k.pem', '-out', '${dir.path}/c.pem', '-subj', '/CN=quetzal-test', '-days', '2']);
    if (r.exitCode != 0) return null;
    final der = await Process.run('openssl', ['x509', '-in', '${dir.path}/c.pem', '-outform', 'DER'], stdoutEncoding: null);
    return (File('${dir.path}/c.pem').readAsStringSync(), File('${dir.path}/k.pem').readAsStringSync(), fingerprintOf(der.stdout as List<int>));
  } catch (_) { return null; }
}

void main() {
  SharedPreferences.setMockInitialValues({});
  test('配对证明：与运行基座（Node crypto.pbkdf2）算出的已知向量一致；配对码的写法不计大小写与连字符；耗时在可接受范围', () async {
    final sw = Stopwatch()..start();
    expect(await pairProof('ABCDEFGH', '00' * 32), '23473714b2a61fbc2a61de0a7636402e197af0b3fe1ee19be90503518e30e4df');
    final ms = sw.elapsedMilliseconds;
    expect(await pairProof('k7mp-2qxr', '3F9A1C0BE5D24477A86E0F1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F'), 'fe1a8c085d10102af4004ba42642242a5cb860cad28ec405b64e480c19e57794');
    // ignore: avoid_print
    print('PBKDF2（10 万次，后台 isolate）耗时 $ms ms');
    expect(ms, lessThan(10000));
  });

  test('网关地址的写法：只填地址时别的机器走 https:7789、本机走 http:7788；旧的 http 局域网地址换成加密端口', () {
    expect(normalizeBase('192.168.1.8'), 'https://192.168.1.8:7789');
    expect(normalizeBase(' 192.168.1.8:9443 '), 'https://192.168.1.8:9443');
    expect(normalizeBase('mybox.local'), 'https://mybox.local:7789');
    expect(normalizeBase('http://192.168.1.8:7788'), 'https://192.168.1.8:7789');
    expect(normalizeBase('http://192.168.1.8'), 'https://192.168.1.8:7789');
    expect(normalizeBase('http://192.168.1.8:8000'), 'https://192.168.1.8:8000');
    expect(normalizeBase('https://192.168.1.8'), 'https://192.168.1.8:7789');
    expect(normalizeBase('https://192.168.1.8:7789/'), 'https://192.168.1.8:7789');
    expect(normalizeBase('127.0.0.1'), 'http://127.0.0.1:7788');
    expect(normalizeBase('localhost:7790'), 'http://localhost:7790');
    expect(normalizeBase('http://127.0.0.1:7788'), 'http://127.0.0.1:7788');
    expect(normalizeBase('https://127.0.0.1:7789'), 'https://127.0.0.1:7789');
    expect(normalizeBase('ftp://x'), isNull);
    expect(normalizeBase('https://x/path'), isNull);
    expect(normalizeBase(''), isNull);
    expect(isLegacyLan('http://192.168.1.8:7788'), isTrue);
    expect(isLegacyLan('http://127.0.0.1:7788'), isFalse);
    expect(isLegacyLan('https://192.168.1.8:7789'), isFalse);
    expect(shortFingerprint('1a2b3c4d5e6f7a8b${'0' * 48}'), '1a2b 3c4d 5e6f 7a8b');
  });

  test('钉住的判定：指纹相同才接受；捕获只对那一个 host:port 生效并记下指纹；按档案重建', () {
    final p = Pins();
    final der = utf8.encode('cert'), fp = fingerprintOf(der);
    expect(p.handles('10.0.0.2', 7789), isFalse);
    expect(p.accept('10.0.0.2', 7789, der), isFalse, reason: '没有钉住：不接受');
    p.pin('10.0.0.2', 7789, fp);
    expect(p.accept('10.0.0.2', 7789, der), isTrue);
    expect(p.accept('10.0.0.2', 7789, utf8.encode('other')), isFalse, reason: '换了证书：不接受');
    expect(p.accept('10.0.0.2', 7790, der), isFalse, reason: '端口不同：不是同一个钉住');
    p.startCapture('10.0.0.3', 7789);
    expect(p.handles('10.0.0.3', 7789), isTrue);
    expect(p.accept('10.0.0.3', 7789, utf8.encode('x')), isTrue);
    expect(p.endCapture('10.0.0.3', 7789), fingerprintOf(utf8.encode('x')));
    expect(p.accept('10.0.0.3', 7789, utf8.encode('x')), isFalse, reason: '捕获结束后不再放行');
    p.load([('https://[fe80::1]:7789', fp), ('http://127.0.0.1:7788', fp), ('https://10.0.0.4:7789', 'zz')]);
    expect(p.pinned('fe80::1', 7789), fp);
    expect(p.pinned('127.0.0.1', 7788), isNull, reason: '明文档案不钉住');
    expect(p.pinned('10.0.0.4', 7789), isNull, reason: '不合法的指纹不收');
    expect(p.pinned('10.0.0.2', 7789), isNull, reason: '重建时清掉旧的');
  });

  group('真实的 TLS 握手', () {
    late Directory dir;
    (String, String, String)? cert;
    HttpServer? srv;
    final seen = <String, dynamic>{};
    setUpAll(() async {
      dir = Directory.systemTemp.createTempSync('quetzal-pin-');
      cert = await selfSigned(dir);
      if (cert == null) return;
      final ctx = SecurityContext()..useCertificateChainBytes(utf8.encode(cert!.$1))..usePrivateKeyBytes(utf8.encode(cert!.$2));
      srv = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, ctx);
      srv!.listen((req) async {
        final fp = cert!.$3;
        if (req.uri.path == '/rpc') {
          final ws = await WebSocketTransformer.upgrade(req);
          ws.listen((raw) {
            final m = jsonDecode('$raw') as Map;
            if (m['auth'] == 'tok') {
              ws.add(jsonEncode({'event': 'hello', 'data': {}}));
            } else if (m['id'] != null) {
              ws.add(jsonEncode({'id': m['id'], 'result': {'version': 'x'}}));
            }
          });
          return;
        }
        final body = await utf8.decodeStream(req);
        req.response.headers.contentType = ContentType.json;
        switch (req.uri.path) {
          case '/pair/info': req.response.write(jsonEncode({'ok': true, 'fingerprint': fp, 'short': shortFingerprint(fp), 'body': 'box', 'version': '9', 'tls': true}));
          case '/pair/start': req.response.write('{"ok":true}');
          case '/pair/finish':
            final j = jsonDecode(body) as Map;
            seen['finish'] = j;
            if (j['proof'] == await pairProof('ABCDEFGH', fp)) { req.response.write(jsonEncode({'ok': true, 'token': 'tok', 'fingerprint': fp})); } else { req.response.statusCode = 403; req.response.write('{"ok":false,"message":"配对码不正确"}'); }
          default: req.response.write('{"ok":true}');
        }
        await req.response.close();
      });
      HttpOverrides.global = PinnedHttpOverrides(pins);
    });
    tearDownAll(() async { await srv?.close(force: true); HttpOverrides.global = null; dir.deleteSync(recursive: true); });

    test('没有钉住时拒绝自签名证书；钉住正确的指纹才通；钉错了不通；捕获记下的就是这张证书', () async {
      if (srv == null) { markTestSkipped('没有 openssl'); return; }
      final url = 'https://127.0.0.1:${srv!.port}/health';
      pins.load([]);
      await expectLater(net.request('GET', url), throwsA(isA<HandshakeException>()));
      pins.pin('127.0.0.1', srv!.port, '0' * 64);
      await expectLater(net.request('GET', url), throwsA(isA<HandshakeException>()));
      pins.pin('127.0.0.1', srv!.port, cert!.$3);
      expect((await net.request('GET', url)).status, 200);
      pins.load([]);
      pins.startCapture('127.0.0.1', srv!.port);
      expect((await net.request('GET', url)).status, 200);
      expect(pins.endCapture('127.0.0.1', srv!.port), cert!.$3);
    });

    test('加密配对的完整流程：捕获并钉住指纹 → 证明换令牌 → wss 连上；错误的配对码被拒；地址换了钉住与令牌一并清掉', () async {
      if (srv == null) { markTestSkipped('没有 openssl'); return; }
      final a = Api()..current = Profile(id: 't', label: '', base: 'https://127.0.0.1:${srv!.port}', token: 'old');
      a.profiles = [a.current!];
      final info = await a.pairInfo();
      expect(info!.fingerprint, cert!.$3);
      expect(a.current!.fp, cert!.$3, reason: '钉住握手时看到的指纹');
      expect(a.current!.token, '', reason: '指纹变了（第一次）：旧令牌作废');
      expect(pins.pinned('127.0.0.1', srv!.port), cert!.$3);
      await a.pairStart();
      await expectLater(a.pairFinish('WRONGXXX'), throwsA(isA<RpcError>()));
      expect((seen['finish'] as Map).containsKey('code'), isFalse, reason: '配对码不上网络');
      await a.pairFinish('abcd-efgh');
      expect(a.current!.token, 'tok');
      for (var i = 0; i < 50 && a.conn != Conn.online; i++) { await Future.delayed(const Duration(milliseconds: 100)); }
      expect(a.conn, Conn.online, reason: 'wss 经钉住的证书连上');
      expect((await a.call<Map>('status'))['version'], 'x');
      await a.saveSettings(base: 'https://127.0.0.1:1');
      expect(a.current!.fp, '');
      expect(a.current!.token, '');
      a.dispose();
    });

    test('旧的明文局域网档案连不上时回到配对页，并提示重新配对', () async {
      final a = Api()..current = Profile(id: 't', label: '', base: 'http://127.0.0.2:1', token: 'tok');
      a.profiles = [a.current!];
      a.connect();
      for (var i = 0; i < 100 && a.conn != Conn.unpaired; i++) { await Future.delayed(const Duration(milliseconds: 100)); }
      expect(a.conn, Conn.unpaired);
      expect(a.lastError, legacyLanMessage);
      a.dispose();
    });
  });
}
