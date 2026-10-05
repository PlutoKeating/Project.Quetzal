// 安装器：启动（或重启）App 内置的运行基座，等它响应，取回网关令牌并核对，控制台随即连上。
//   只装一个 App：运行环境（Node.js、git、ssh、proot）随 APK 安装，第一次启动时由前台服务解压（见 RuntimeService / Rootfs）；
//   新版 App 带着新版运行基座，所以升级 = 重启前台服务。家目录（记忆、配置、密钥）不受影响。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'igniter.dart';

/// 内置运行基座的网关端口（RuntimeService.PORT 与运行基座的缺省端口一致）。
const runtimePort = 7788;

const installSteps = <String, String>{
  'start': '解开内置的运行环境，启动运行基座',
  'health': '等待运行基座响应（第一次要多等一会儿）',
  'connect': '连接控制台',
};

class Installer extends ChangeNotifier {
  /// 可替换的原生操作（测试里换成假的）。
  @visibleForTesting
  static Future<void> Function() restart = Igniter.restart;
  @visibleForTesting
  static Future<String?> Function() readToken = Igniter.token;
  @visibleForTesting
  static Future<bool> Function() embeddedRunning = () async => (await Igniter.status())['running'] == true;
  @visibleForTesting
  static int port = runtimePort;
  @visibleForTesting
  static Duration healthTimeout = const Duration(seconds: 180);

  bool running = false, done = false;
  String? error, version, token;
  final reached = <String>[];

  /// App 内置的运行基座版本；此构建没有内置时为 null。
  static Future<String?> bundledVersion() async {
    try { return (await rootBundle.loadString('assets/runtime/VERSION')).trim(); } catch (_) { return null; }
  }

  void _step(String s) { if (!reached.contains(s)) reached.add(s); notifyListeners(); }
  void _fail(String e) { error = e; running = false; notifyListeners(); }

  /// 开始安装（或升级、修复）：重启前台服务 → 等 /health → 取令牌并核对。进度通过 reached / error / done 观察。
  Future<void> install() async {
    reached.clear(); error = null; done = false; running = true; notifyListeners();
    _step('start');
    // 端口上已经有一个不是本 App 启动的运行基座（旧版装在 Termux 里的）：再启动一个只会抢端口
    if (!await embeddedRunning() && await health(port) != null) {
      _fail('这台手机上已经有一个运行基座在运行（多半是旧版装在 Termux 里的）。迁移：先确认灵魂已推送到灵魂仓库，然后卸载 Termux 版（或在 Termux 里 sv down quetzal），再回到这里安装，并在新装好的 App 里接入同一个灵魂仓库（接入前不要改身份）。');
      return;
    }
    try { await restart(); } catch (e) { _fail('启动运行基座失败：$e'); return; }
    _step('health');
    final deadline = DateTime.now().add(healthTimeout);
    Map? h;
    while (DateTime.now().isBefore(deadline)) {
      h = await health(port);
      if (h != null) break;
      await Future.delayed(const Duration(seconds: 1));
    }
    if (h == null) { _fail('运行基座 ${healthTimeout.inSeconds} 秒内没有响应（日志在 App 数据目录的 home/quetzal/data/runtime.log）'); return; }
    version = h['version']?.toString();
    _step('connect');
    String? t;
    for (var i = 0; i < 20 && t == null; i++) { t = await readToken(); if (t == null) await Future.delayed(const Duration(milliseconds: 500)); }
    if (t == null) { _fail('读不到网关令牌'); return; }
    final err = await verifyGateway(port, t);
    if (err != null) { _fail('运行基座已启动，但核对网关失败：$err'); return; }
    token = t; done = true; running = false; notifyListeners();
  }

  /// GET /health → JSON；连不上返回 null。
  static Future<Map?> health(int port) async {
    final c = HttpClient()..connectionTimeout = const Duration(seconds: 2);
    try {
      final res = await (await c.getUrl(Uri.parse('http://127.0.0.1:$port/health'))).close().timeout(const Duration(seconds: 4));
      final j = jsonDecode(await res.transform(utf8.decoder).join());
      return res.statusCode == 200 && j is Map && j['ok'] == true ? j : null;
    } catch (_) { return null; } finally { c.close(force: true); }
  }

  /// 核对 `127.0.0.1:<port>` 上是运行基座的网关，且 [token] 能通过认证：GET /health，再做一次 status RPC。
  /// 先用第一条消息认证，不行再用旧版的 ?token=。通过返回 null，否则返回原因。
  static Future<String?> verifyGateway(int port, String token, {Duration timeout = const Duration(seconds: 10)}) async {
    if (await health(port) == null) return '网关健康检查没有通过';
    for (final legacy in [false, true]) {
      WebSocket? ws;
      try {
        ws = await WebSocket.connect('ws://127.0.0.1:$port/rpc${legacy ? '?token=${Uri.encodeComponent(token)}' : ''}').timeout(timeout);
        final s = ws;
        if (!legacy) s.add(jsonEncode({'auth': token}));
        var sent = false;
        void ask() { if (!sent) { sent = true; s.add(jsonEncode({'id': 1, 'method': 'status', 'params': {}})); } }
        final t = Timer(const Duration(seconds: 2), ask); // 认证后网关会推 hello，收到就问；没推也照问
        try {
          await for (final raw in s.timeout(timeout)) {
            ask();
            final m = jsonDecode('$raw');
            if (m is Map && m['id'] == 1) return m['result'] is Map ? null : '带令牌的请求被拒绝';
          }
        } finally { t.cancel(); }
      } catch (_) {
        // 认证不通过时网关直接断开：换旧方式再试一次
      } finally { await ws?.close(); }
    }
    return '令牌没有通过网关的认证';
  }
}
