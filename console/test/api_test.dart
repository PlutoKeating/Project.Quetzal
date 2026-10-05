// 网关客户端的认证方式：WebSocket 先用第一条消息 {"auth"} 认证，旧版运行基座（握手就要 ?token=）自动退回；HTTP 用请求头。
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';

Future<(HttpServer, List<String>)> gateway({required bool legacy}) async {
  final seen = <String>[];
  final srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  srv.listen((req) async {
    final q = req.uri.queryParameters['token'];
    seen.add(q == null ? 'ws' : 'ws?token');
    if (legacy && q != 'good') { req.response.statusCode = 401; await req.response.close(); return; }
    final ws = await WebSocketTransformer.upgrade(req);
    var authed = legacy;
    if (legacy) ws.add(jsonEncode({'event': 'hello', 'data': {}}));
    ws.listen((raw) {
      final m = jsonDecode('$raw') as Map;
      if (!authed) { if (m['auth'] == 'good') { authed = true; seen.add('auth'); ws.add(jsonEncode({'event': 'hello', 'data': {}})); } else { ws.close(); } return; }
      if (m['id'] != null) ws.add(jsonEncode({'id': m['id'], 'result': {'version': 'x'}}));
    });
  });
  return (srv, seen);
}

void main() {
  for (final legacy in [false, true]) {
    test('WebSocket 认证：${legacy ? '旧版运行基座退回 ?token=' : '第一条消息 {"auth"}，网址里没有令牌'}', () async {
      final (srv, seen) = await gateway(legacy: legacy);
      final a = Api()..current = Profile(id: 't', label: '', base: 'http://127.0.0.1:${srv.port}', token: 'good');
      a.connect();
      for (var i = 0; i < 50 && a.conn != Conn.online; i++) { await Future.delayed(const Duration(milliseconds: 100)); }
      expect(a.conn, Conn.online);
      expect((await a.call<Map>('status'))['version'], 'x');
      expect(seen, legacy ? ['ws', 'ws?token'] : ['ws', 'auth']);
      a.dispose();
      await srv.close(force: true);
    });
  }

  test('HTTP 令牌放在请求头里', () {
    final a = Api()..current = Profile(id: 't', label: '', base: 'http://127.0.0.1:1', token: 'tk');
    expect(a.authHeaders['X-Quetzal-Token'], 'tk');
    a.current!.token = '';
    expect(a.authHeaders, isEmpty);
  });
}
