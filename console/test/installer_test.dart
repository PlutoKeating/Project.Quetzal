// 安装器：重启内置运行基座 → 等 /health → 取令牌并核对网关。
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/installer.dart';

/// 一个假的网关：/health 与 /rpc（第一条消息认证；legacy 时认 ?token=）。
Future<HttpServer> fakeGateway({bool legacy = false, String good = 'good'}) async {
  final srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  srv.listen((req) async {
    if (req.uri.path == '/health') { req.response.write(jsonEncode({'ok': true, 'version': '9.9.9'})); await req.response.close(); return; }
    if (legacy && req.uri.queryParameters['token'] != good) { req.response.statusCode = 401; await req.response.close(); return; }
    final ws = await WebSocketTransformer.upgrade(req);
    var authed = legacy;
    ws.listen((raw) {
      final m = jsonDecode('$raw') as Map;
      if (!authed) { if (m['auth'] == good) { authed = true; ws.add(jsonEncode({'event': 'hello', 'data': {}})); } else { ws.close(); } return; }
      if (m['id'] != null) ws.add(jsonEncode({'id': m['id'], 'result': {'version': 'x'}}));
    });
  });
  return srv;
}

void main() {
  test('步骤', () => expect(installSteps.keys, ['start', 'health', 'connect']));

  test('安装：重启服务、等到网关响应、令牌核对通过才算完成', () async {
    final srv = await fakeGateway();
    var restarted = 0;
    Installer.restart = () async { restarted++; };
    Installer.embeddedRunning = () async => true; // 升级：网关就是 App 自己的
    Installer.readToken = () async => 'good';
    Installer.port = srv.port;
    final ins = Installer();
    await ins.install();
    expect(restarted, 1);
    expect(ins.error, null); expect(ins.done, true); expect(ins.version, '9.9.9'); expect(ins.token, 'good');
    expect(ins.reached, ['start', 'health', 'connect']);
    await srv.close(force: true);
  });

  test('端口上已有不是本 App 启动的运行基座（旧版 Termux）：不再启动第二个', () async {
    final srv = await fakeGateway();
    var restarted = 0;
    Installer.restart = () async { restarted++; };
    Installer.embeddedRunning = () async => false;
    Installer.port = srv.port;
    final ins = Installer();
    await ins.install();
    expect(restarted, 0); expect(ins.done, false); expect(ins.error, contains('Termux'));
    Installer.embeddedRunning = () async => true;
    await srv.close(force: true);
  });

  test('令牌不对：不算完成', () async {
    final srv = await fakeGateway();
    Installer.restart = () async {};
    Installer.readToken = () async => 'bad';
    Installer.port = srv.port;
    final ins = Installer();
    await ins.install();
    expect(ins.done, false); expect(ins.error, contains('核对网关失败'));
    await srv.close(force: true);
  });

  test('网关一直不响应：超时报错', () async {
    final dead = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0); final port = dead.port; await dead.close();
    Installer.restart = () async {};
    Installer.port = port;
    Installer.healthTimeout = const Duration(seconds: 2);
    final ins = Installer();
    await ins.install();
    expect(ins.done, false); expect(ins.error, contains('没有响应'));
  });

  test('网关核对：/health 与带令牌的 status RPC（第一条消息认证；不行退回 ?token=）', () async {
    for (final legacy in [false, true]) {
      final srv = await fakeGateway(legacy: legacy);
      expect(await Installer.verifyGateway(srv.port, 'good'), null, reason: 'legacy=$legacy');
      expect(await Installer.verifyGateway(srv.port, 'bad', timeout: const Duration(seconds: 3)), isNotNull);
      await srv.close(force: true);
    }
  });
}
