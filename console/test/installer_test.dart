// 安装器：下发给 Termux 的命令、进度回报的解析、本机 HTTP 服务的路由。
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/installer.dart';

void main() {
  Installer.loadAsset = (k) async { final b = await File(k).readAsBytes(); return ByteData.sublistView(b); }; // 直接读仓库里的资源文件
  test('下发的命令：带口令取回脚本、核对脚本哈希再执行；端口、口令、各文件哈希与镜像参数透传', () {
    final sums = {'install.sh': 'a' * 64, 'main.cjs': 'b' * 64, 'termux.mjs': 'c' * 64};
    final cmd = Installer.command(4567, 'f' * 32, sums);
    expect(cmd, contains('-H "X-Install-Nonce: ${'f' * 32}" http://127.0.0.1:4567/install.sh'));
    expect(cmd, contains('echo "${'a' * 64}  \$PREFIX/tmp/quetzal-install.sh" | sha256sum -c --status'));
    expect(cmd, endsWith(' 4567 ${'f' * 32} main.cjs=${'b' * 64},termux.mjs=${'c' * 64}'));
    expect(Installer.command(4567, 'f' * 32, sums, cnMirror: true), endsWith(' cn'));
  });

  test('口令：128 位随机十六进制，每次不同；定长比较', () {
    final a = Installer.newNonce(), b = Installer.newNonce();
    expect(a, matches(RegExp(r'^[0-9a-f]{32}$'))); expect(a == b, false);
    expect(sameSecret(a, a), true); expect(sameSecret(a, b), false); expect(sameSecret(a, null), false); expect(sameSecret('ab', 'abc'), false);
  });

  test('进度回报的解析', () {
    final p = Progress.fromJson({'step': 'pkg'});
    expect(p.step, 'pkg'); expect(p.done, false); expect(p.error, null);
    final d = Progress.fromJson({'done': true, 'version': '0.2.0', 'port': 7788, 'token': 't'});
    expect(d.done, true); expect(d.port, 7788); expect(d.token, 't'); expect(d.version, '0.2.0');
    final e = Progress.fromJson({'error': '安装软件包失败', 'log': 'E: ...'});
    expect(e.error, '安装软件包失败'); expect(e.log, 'E: ...');
    expect(installSteps.keys, ['pkg', 'runtime', 'mesh', 'service', 'config', 'start', 'health']);
  });

  test('本机 HTTP 服务：没有口令、口令不对、Host 不对都拒绝；progress 只收 JSON；只提供白名单里的文件', () async {
    final ins = Installer();
    await ins.start();
    expect(ins.port, greaterThan(0));
    final n = ins.newSession();
    final c = HttpClient();
    Future<HttpClientResponse> req(String method, String path, {String body = '', String? nonce, String? host, bool json = true}) async {
      final r = await c.openUrl(method, Uri.parse('http://127.0.0.1:${ins.port}$path'));
      if (nonce != null) r.headers.set('X-Install-Nonce', nonce);
      if (host != null) r.headers.host = host;
      if (json) r.headers.contentType = ContentType.json;
      r.write(body);
      return r.close();
    }
    expect((await req('POST', '/ping')).statusCode, 403);
    expect((await req('POST', '/ping', nonce: 'x' * 32)).statusCode, 403);
    expect((await req('POST', '/ping', nonce: n, host: 'evil.example')).statusCode, 403);
    expect(ins.pinged, false);
    expect((await req('POST', '/ping', nonce: n)).statusCode, 200);
    expect(ins.pinged, true);
    expect((await req('POST', '/progress', nonce: n, body: jsonEncode({'step': 'pkg'}), json: false)).statusCode, 415);
    expect(ins.reached, isEmpty);
    await req('POST', '/progress', nonce: n, body: jsonEncode({'step': 'pkg'}));
    await req('POST', '/progress', nonce: n, body: jsonEncode({'step': 'runtime'}));
    expect(ins.reached, ['pkg', 'runtime']);
    final sh = await req('GET', '/install.sh', nonce: n, json: false);
    expect(sh.statusCode, 200);
    final served = await sh.fold<List<int>>([], (a, b) => a..addAll(b));
    expect(sha256.convert(served).toString(), (await Installer.fileHashes())['install.sh']);
    expect((await req('GET', '/install.sh', json: false)).statusCode, 403);
    expect((await req('GET', '/nothing', nonce: n, json: false)).statusCode, 404);
    expect((await req('GET', '/runtime/../../etc/passwd', nonce: n, json: false)).statusCode, 404);
    expect((await req('GET', '/runtime/other.bin', nonce: n, json: false)).statusCode, 404);
    await req('POST', '/progress', nonce: n, body: jsonEncode({'error': 'x', 'log': 'l'}));
    expect(ins.error, 'x'); expect(ins.running, false);
    // 失败之后口令作废
    expect((await req('POST', '/ping', nonce: n)).statusCode, 403);
    c.close(force: true);
    ins.dispose();
  });

  test('完成回报：网关核对不通过就不算完成', () async {
    final ins = Installer();
    await ins.start();
    final n = ins.newSession();
    final c = HttpClient();
    final dead = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0); final deadPort = dead.port; await dead.close();
    final r = await c.postUrl(Uri.parse('http://127.0.0.1:${ins.port}/progress'));
    r.headers..set('X-Install-Nonce', n)..contentType = ContentType.json;
    r.write(jsonEncode({'done': true, 'version': '1.0.0', 'port': deadPort, 'token': 't'}));
    await r.close();
    for (var i = 0; i < 50 && (ins.verifying || ins.last == null); i++) { await Future.delayed(const Duration(milliseconds: 100)); }
    expect(ins.done, false); expect(ins.error, contains('核对网关失败'));
    c.close(force: true);
    ins.dispose();
  });

  test('网关核对：/health 与带令牌的 status RPC（第一条消息认证；不行退回 ?token=）', () async {
    for (final legacyServer in [false, true]) {
      final srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      srv.listen((req) async {
        if (req.uri.path == '/health') { req.response.write(jsonEncode({'ok': true})); await req.response.close(); return; }
        if (legacyServer && req.uri.queryParameters['token'] != 'good') { req.response.statusCode = 401; await req.response.close(); return; }
        final ws = await WebSocketTransformer.upgrade(req);
        var authed = legacyServer;
        ws.listen((raw) {
          final m = jsonDecode('$raw') as Map;
          if (!authed) { if (m['auth'] == 'good') { authed = true; ws.add(jsonEncode({'event': 'hello', 'data': {}})); } else { ws.close(); } return; }
          if (m['id'] != null) ws.add(jsonEncode({'id': m['id'], 'result': {'version': 'x'}}));
        });
      });
      expect(await Installer.verifyGateway(srv.port, 'good'), null, reason: 'legacy=$legacyServer');
      expect(await Installer.verifyGateway(srv.port, 'bad', timeout: const Duration(seconds: 3)), isNotNull);
      await srv.close(force: true);
    }
  });
}
