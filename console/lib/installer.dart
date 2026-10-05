// 安装器：把 App 内置的运行基座装进同一台手机的 Termux，之后的升级与修复也走这里。
//   控制台在 127.0.0.1 开一个临时 HTTP 服务，向 Termux 提供安装脚本与运行基座文件，并接收脚本回报的进度与结果；
//   命令本身通过 Termux 的 RUN_COMMAND 发出（见 igniter.dart）。Termux 侧的全部步骤在 assets/install/install.sh。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
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

class Installer extends ChangeNotifier {
  HttpServer? _server;
  int get port => _server?.port ?? 0;
  bool pinged = false, running = false;
  final reached = <String>[]; // 已到达的步骤（按顺序）
  Progress? last;
  String? get error => last?.error;
  bool get done => last?.done == true;

  /// App 内置的运行基座版本；此构建没有内置时为 null。
  static Future<String?> bundledVersion() async {
    try { return (await rootBundle.loadString('assets/runtime/VERSION')).trim(); } catch (_) { return null; }
  }

  /// 安装器在 Termux 里执行的命令：先从控制台取回脚本再运行，脚本自己回报进度。
  static String command(int port, {bool cnMirror = false}) =>
      'curl -fsS http://127.0.0.1:$port/install.sh -o "\$PREFIX/tmp/quetzal-install.sh" && bash "\$PREFIX/tmp/quetzal-install.sh" $port${cnMirror ? ' cn' : ''}';

  Future<void> start() async {
    if (_server != null) return;
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handle, onError: (_) {});
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    try {
      final p = req.uri.path;
      if (req.method == 'POST' && p == '/ping') { pinged = true; notifyListeners(); res.write('ok'); }
      else if (req.method == 'POST' && p == '/progress') {
        final m = jsonDecode(await utf8.decoder.bind(req).join()) as Map;
        _progress(Progress.fromJson(m));
        res.write('ok');
      } else if (req.method == 'GET' && p == '/install.sh') {
        res.headers.contentType = ContentType('text', 'x-shellscript', charset: 'utf-8');
        res.write(await rootBundle.loadString('assets/install/install.sh'));
      } else if (req.method == 'GET' && p.startsWith('/runtime/') && !p.contains('..')) {
        final data = await rootBundle.load('assets$p');
        res.headers.contentType = ContentType.binary;
        res.contentLength = data.lengthInBytes;
        res.add(data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
      } else { res.statusCode = 404; }
    } catch (e) { res.statusCode = 500; res.write('$e'); }
    await res.close();
  }

  void _progress(Progress p) {
    last = p;
    if (p.step != null && !reached.contains(p.step)) reached.add(p.step!);
    if (p.done || p.error != null) running = false;
    notifyListeners();
  }

  /// 探测 Termux 是否接受我们的命令：让它回连一下。6 秒没有回应就是没开启外部调用（或 Termux 还没初始化）。
  Future<bool> probe() async {
    await start();
    pinged = false;
    try { await Igniter.bash('curl -s -m 3 -X POST http://127.0.0.1:$port/ping'); } catch (_) { return false; }
    for (var i = 0; i < 30 && !pinged; i++) { await Future.delayed(const Duration(milliseconds: 200)); }
    return pinged;
  }

  /// 开始安装（或升级、修复）。进度通过 reached / last 观察。
  Future<void> install({bool cnMirror = false}) async {
    await start();
    reached.clear(); last = null; running = true; notifyListeners();
    try { await Igniter.bash(command(port, cnMirror: cnMirror)); }
    catch (e) { _progress(Progress(error: '无法把命令交给 Termux：$e')); }
  }

  @override
  void dispose() { _server?.close(force: true); super.dispose(); }
}
