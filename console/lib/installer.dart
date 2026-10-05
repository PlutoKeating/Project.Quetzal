// 安装器：把 App 内置的运行基座装进同一台手机的 Termux，之后的升级与修复也走这里。
//   控制台在 127.0.0.1 开一个临时 HTTP 服务，向 Termux 提供安装脚本与运行基座文件，并接收脚本回报的进度与结果；
//   命令本身通过 Termux 的 RUN_COMMAND 发出（见 igniter.dart）。Termux 侧的全部步骤在 assets/install/install.sh。
//   本机端口谁都能连，所以每次探测 / 安装生成一个 128 位随机口令（nonce），连同每个文件的 SHA-256 写进 RUN_COMMAND 的参数
//   （只有 Termux 看得到）：脚本每个请求都带上口令（请求头 X-Install-Nonce），下载的每个文件先核对哈希再用；
//   这里拒绝没有口令、Host 不是 127.0.0.1:<端口>、/progress 不是 application/json 的请求。
//   脚本交回的网关令牌先用 /health 与一次带令牌的 RPC 核对，通过了才保存。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'igniter.dart';

/// 安装脚本回报的一条进度。
class Progress {
  final String? step, error, log, token, version;
  final int? port; // 网关端口（完成时随令牌一起回报）
  final bool done;
  Progress({this.step, this.error, this.log, this.token, this.version, this.port, this.done = false});
  factory Progress.fromJson(Map m) => Progress(
      step: m['step'] as String?, error: m['error'] as String?, log: m['log'] as String?,
      token: m['token'] as String?, version: m['version']?.toString(), port: (m['port'] as num?)?.toInt(), done: m['done'] == true);
}

const installSteps = <String, String>{
  'pkg': '安装软件包（Node.js、runit、Termux:API、git）',
  'runtime': '放入运行基座',
  'mesh': '下载多具身体直连的组件',
  'service': '注册服务与开机自启',
  'config': '写入设备配置',
  'start': '启动运行基座',
  'health': '健康检查',
};

/// 本机 HTTP 服务只提供这些文件（相对 assets/）。
const servedFiles = <String>['install/install.sh', 'runtime/VERSION', 'runtime/main.cjs', 'runtime/termux.mjs', 'runtime/mesh-modules.lock.json', 'runtime/install-mesh-modules.mjs'];

/// 定长比较，不因提前退出泄露位置。
bool sameSecret(String? a, String? b) {
  if (a == null || b == null || a.length != b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) { d |= a.codeUnitAt(i) ^ b.codeUnitAt(i); }
  return d == 0;
}

class Installer extends ChangeNotifier {
  /// 读内置资源（测试里换成直接读文件：测试绑定会屏蔽真实网络）。
  @visibleForTesting
  static Future<ByteData> Function(String key) loadAsset = rootBundle.load;
  HttpServer? _server;
  int get port => _server?.port ?? 0;
  bool pinged = false, running = false, verifying = false;
  final reached = <String>[]; // 已到达的步骤（按顺序）
  Progress? last;
  String? _nonce; // 本次探测 / 安装的口令；结束（完成或失败）后作废
  String? get error => last?.error;
  bool get done => last?.done == true;

  /// App 内置的运行基座版本；此构建没有内置时为 null。
  static Future<String?> bundledVersion() async {
    try { return (await rootBundle.loadString('assets/runtime/VERSION')).trim(); } catch (_) { return null; }
  }

  /// 128 位随机口令（十六进制）。
  static String newNonce() { final r = Random.secure(); return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join(); }

  /// 开始新的一次会话（探测或安装）：换一个口令，旧口令立即作废。
  @visibleForTesting
  String newSession() => _nonce = newNonce();

  /// 内置文件的 SHA-256：{ 文件名（不含目录）: 哈希 }；此构建没有的文件不列出。
  static Future<Map<String, String>> fileHashes() async {
    final m = <String, String>{};
    for (final f in servedFiles) {
      try { final d = await loadAsset('assets/$f'); m[f.split('/').last] = sha256.convert(d.buffer.asUint8List(d.offsetInBytes, d.lengthInBytes)).toString(); } catch (_) {}
    }
    return m;
  }

  /// 安装器在 Termux 里执行的命令：带口令取回脚本，核对脚本的哈希再运行；口令与运行基座各文件的哈希作为参数交给脚本。
  static String command(int port, String nonce, Map<String, String> sums, {bool cnMirror = false}) {
    final list = sums.entries.where((e) => e.key != 'install.sh').map((e) => '${e.key}=${e.value}').join(',');
    const f = '"\$PREFIX/tmp/quetzal-install.sh"';
    return 'rm -f $f && curl -fsS -H "X-Install-Nonce: $nonce" http://127.0.0.1:$port/install.sh -o $f'
        ' && echo "${sums['install.sh']}  \$PREFIX/tmp/quetzal-install.sh" | sha256sum -c --status'
        ' && bash $f $port $nonce $list${cnMirror ? ' cn' : ''}';
  }

  Future<void> start() async {
    if (_server != null) return;
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handle, onError: (_) {});
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      final p = req.uri.path;
      if (req.headers.value(HttpHeaders.hostHeader) != '127.0.0.1:$port' || !sameSecret(req.headers.value('x-install-nonce'), _nonce)) {
        res.statusCode = 403;
      } else if (req.method == 'POST' && p == '/ping') { pinged = true; notifyListeners(); res.write('ok'); }
      else if (req.method == 'POST' && p == '/progress') {
        if (req.headers.contentType?.mimeType != 'application/json') { res.statusCode = 415; }
        else {
          final body = await utf8.decoder.bind(req).join();
          if (body.length > 65536) { res.statusCode = 413; } else { _progress(Progress.fromJson(jsonDecode(body) as Map)); res.write('ok'); }
        }
      } else if (req.method == 'GET' && servedFiles.contains(p == '/install.sh' ? 'install$p' : p.substring(1))) {
        final data = await loadAsset(p == '/install.sh' ? 'assets/install/install.sh' : 'assets$p');
        res.headers.contentType = p == '/install.sh' ? ContentType('text', 'x-shellscript', charset: 'utf-8') : ContentType.binary;
        res.contentLength = data.lengthInBytes;
        res.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      } else { res.statusCode = 404; }
    } catch (e) { res.statusCode = 500; }
    await res.close();
  }

  void _progress(Progress p) {
    if (p.done) { _finish(p); return; }
    _apply(p);
  }

  void _apply(Progress p) {
    last = p;
    if (p.step != null && !reached.contains(p.step)) reached.add(p.step!);
    if (p.done || p.error != null) { running = false; _nonce = null; }
    notifyListeners();
  }

  /// 脚本说完成了：先核对它交回的端口与令牌真能用，再算完成。
  Future<void> _finish(Progress p) async {
    if (verifying) return;
    final port = p.port ?? 7788, token = p.token;
    _nonce = null; // 不再接受任何回报
    verifying = true; notifyListeners();
    final err = (token == null || token.isEmpty || port < 1 || port > 65535) ? '安装脚本没有交回有效的端口与令牌' : await verifyGateway(port, token);
    verifying = false;
    _apply(err == null ? p : Progress(error: '安装似乎完成了，但核对网关失败：$err', step: p.step));
  }

  /// 核对 `127.0.0.1:<port>` 上是运行基座的网关，且 [token] 能通过认证：GET /health，再做一次 status RPC。
  /// 先用第一条消息认证，不行再用旧版的 ?token=。通过返回 null，否则返回原因。
  static Future<String?> verifyGateway(int port, String token, {Duration timeout = const Duration(seconds: 10)}) async {
    final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
    try {
      final res = await (await c.getUrl(Uri.parse('http://127.0.0.1:$port/health'))).close().timeout(timeout);
      final j = jsonDecode(await res.transform(utf8.decoder).join());
      if (res.statusCode != 200 || j is! Map || j['ok'] != true) return '网关健康检查没有通过';
    } catch (e) { return '连不上网关（$e）'; } finally { c.close(force: true); }
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

  /// 探测 Termux 是否接受我们的命令：让它回连一下。6 秒没有回应就是没开启外部调用（或 Termux 还没初始化）。
  Future<bool> probe() async {
    await start();
    pinged = false;
    final n = newSession();
    try { await Igniter.bash('curl -s -m 3 -X POST -H "X-Install-Nonce: $n" http://127.0.0.1:$port/ping'); } catch (_) { return false; }
    for (var i = 0; i < 30 && !pinged; i++) { await Future.delayed(const Duration(milliseconds: 200)); }
    return pinged;
  }

  /// 开始安装（或升级、修复）。进度通过 reached / last 观察。
  Future<void> install({bool cnMirror = false}) async {
    await start();
    reached.clear(); last = null; running = true; notifyListeners();
    final sums = await fileHashes();
    if (!['install.sh', 'VERSION', 'main.cjs', 'termux.mjs'].every(sums.containsKey)) { _apply(Progress(error: '此构建缺少内置的运行基座文件')); return; }
    final n = newSession();
    try { await Igniter.bash(command(port, n, sums, cnMirror: cnMirror)); }
    catch (e) { _apply(Progress(error: '无法把命令交给 Termux：$e')); }
  }

  @override
  void dispose() { _server?.close(force: true); super.dispose(); }
}
