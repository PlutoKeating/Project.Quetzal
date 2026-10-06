// dart:io 平台：原生桌面控制台（Linux / Windows）的本机能力。安卓也编译这一份，但这里的函数只在桌面上起作用。
//   - 本机免配对（docs/WINDOWS_DECISIONS.md Q21 a）：控制台与运行基座是同一个系统用户、控制台不在沙箱里，
//     直接读 QUETZAL_HOME/secrets/gateway.token（与安卓 App 读自己家目录里的令牌同理），读不到再走网关的 GET /auth/local。
//   - 身体助手（Windows，约定 4.3）：运行基座在开机任务里跑在会话 0，拿不到桌面；通知、截图、剪贴板、播放、相机、录音交给用户会话里的
//     `"<node>" ROOT\runtime\<当前版本>\windows-body.mjs`。托盘进程登录时把它以不显示窗口的方式拉起、崩溃退避重启、
//     运行基座换了版本就换成新版本的；它被放进随控制台结束的作业对象（windows/runner/flutter_window.cpp），控制台退出或崩溃时一起结束。
import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart' show debugPrint, visibleForTesting;
import 'package:flutter/services.dart' show MethodChannel;
import '../installer.dart' show Installer;
import 'desktop_paths.dart';

DesktopLayout get _layout => DesktopLayout(windows: Platform.isWindows, env: Platform.environment);
bool get _desktop => Platform.isLinux || Platform.isWindows || Platform.isMacOS;

/// 家目录里的网关令牌；不是桌面、文件不存在或为空时为 null。
Future<String?> readLocalGatewayToken() async {
  if (!_desktop) return null;
  final p = _layout.gatewayToken;
  if (p == null) return null;
  try { final t = (await File(p).readAsString()).trim(); return t.isEmpty ? null : t; } catch (_) { return null; }
}

/// 这个令牌能不能通过本机 [port] 上网关的认证（家目录可能属于另一份安装，不能只看文件在不在）。
Future<bool> verifyLocalToken(int port, String token) async => await Installer.verifyGateway(port, token, timeout: const Duration(seconds: 5)) == null;

String? _readText(String? path) {
  if (path == null) return null;
  try { return File(path).readAsStringSync(); } catch (_) { return null; }
}

/// Windows 的身体助手看护者。
class BodyHelper {
  static final instance = BodyHelper();

  final DesktopLayout layout;
  final Future<Process> Function(String exe, List<String> args, Map<String, String> env) spawn;
  final Future<bool> Function(int pid) adopt;
  final String? Function(String? path) read;
  final bool Function(String path) exists;

  BodyHelper({DesktopLayout? layout, Future<Process> Function(String, List<String>, Map<String, String>)? spawn,
      Future<bool> Function(int)? adopt, String? Function(String?)? read, bool Function(String)? exists})
      : layout = layout ?? _layout,
        spawn = spawn ?? ((exe, args, env) => Process.start(exe, args, environment: env)), // 普通模式：Windows 上 Dart 带 CREATE_NO_WINDOW，不弹控制台窗口
        adopt = adopt ?? _adopt,
        read = read ?? _readText,
        exists = exists ?? ((p) => File(p).existsSync());

  static Future<bool> _adopt(int pid) async {
    try { return await const MethodChannel('quetzal/desktop').invokeMethod<bool>('adopt', pid) ?? false; } catch (_) { return false; }
  }

  Process? _proc;
  BodyHelperCommand? _cmd;
  bool _on = false;
  int _failures = 0;
  Timer? _retry;
  DateTime? _startedAt;

  @visibleForTesting
  bool get running => _proc != null;
  @visibleForTesting
  BodyHelperCommand? get command => _cmd;
  @visibleForTesting
  int get failures => _failures;

  BodyHelperCommand? _want() => layout.bodyHelper(nodeTxt: read(layout.nodePointer), runtimeCurrentTxt: read(layout.runtimePointer));

  /// 开始看护（只在 Windows 上）。
  void start() {
    if (!layout.windows || _on) return;
    _on = true;
    unawaited(_launch());
  }

  Future<void> _launch() async {
    _retry = null;
    if (!_on || _proc != null) return;
    final cmd = _want();
    final home = layout.home;
    if (cmd == null || home == null || !exists(cmd.script)) { _failures++; _schedule(); return; } // 还没装好（或运行基座太旧没有身体助手）：过一会儿再看
    try {
      final p = await spawn(cmd.node, [cmd.script], {'QUETZAL_HOME': home});
      if (!_on) { p.kill(); return; }
      _proc = p; _cmd = cmd; _startedAt = DateTime.now();
      if (!await adopt(p.pid)) debugPrint('身体助手没能放进作业对象（控制台崩溃时它不会跟着结束）');
      p.stdout.listen((_) {}, onError: (_) {}); // 它自己写日志；这里只要把管道读空，免得写满了卡住它
      p.stderr.listen((_) {}, onError: (_) {});
      unawaited(p.exitCode.then((code) {
        if (_proc != p) return;
        _proc = null;
        final ran = DateTime.now().difference(_startedAt ?? DateTime.now());
        _failures = ran > const Duration(minutes: 1) ? 0 : _failures + 1; // 跑了一阵才退出的不算连续失败
        debugPrint('身体助手退出（$code），${restartBackoff(_failures).inSeconds} 秒后重新拉起');
        _schedule();
      }));
    } catch (e) {
      debugPrint('身体助手起不来：$e');
      _failures++;
      _schedule();
    }
  }

  void _schedule() {
    if (!_on) return;
    _retry?.cancel();
    _retry = Timer(restartBackoff(_failures), () => unawaited(_launch()));
  }

  /// 托盘每分钟调用一次：运行基座换了版本（runtime\current.txt 变了）或 node 换了，就结束旧的、拉起新的。
  void check() {
    if (!_on) return;
    final want = _want();
    final p = _proc;
    if (p != null && want != null && want != _cmd) {
      _proc = null; _failures = 0;
      p.kill();
      _retry?.cancel();
      unawaited(_launch());
    }
  }

  /// 结束身体助手并停止看护（托盘「退出」）。
  Future<void> stop() async {
    _on = false;
    _retry?.cancel(); _retry = null;
    final p = _proc;
    _proc = null;
    p?.kill();
  }
}
