// 原生桌面控制台（Linux / Windows）的目录约定、换版本检测与身体助手的看护。
import 'dart:async';
import 'dart:io';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/platform/desktop_io.dart';
import 'package:quetzal_console/platform/desktop_paths.dart';

const win = {'LOCALAPPDATA': r'C:\Users\u\AppData\Local'};

class FakeProcess implements Process {
  @override
  final int pid;
  final _exit = Completer<int>();
  bool killed = false;
  FakeProcess(this.pid);
  @override
  Stream<List<int>> get stdout => const Stream.empty();
  @override
  Stream<List<int>> get stderr => const Stream.empty();
  @override
  IOSink get stdin => throw UnimplementedError();
  @override
  Future<int> get exitCode => _exit.future;
  void exit(int code) { if (!_exit.isCompleted) _exit.complete(code); }
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) { killed = true; exit(-1); return true; }
}

void main() {
  group('家目录与网关令牌', () {
    test('Linux：QUETZAL_HOME 优先，缺省 ~/.quetzal', () {
      expect(const DesktopLayout(windows: false, env: {'HOME': '/home/u'}).gatewayToken, '/home/u/.quetzal/secrets/gateway.token');
      expect(const DesktopLayout(windows: false, env: {'HOME': '/home/u', 'QUETZAL_HOME': '/srv/q/'}).gatewayToken, '/srv/q/secrets/gateway.token');
      expect(const DesktopLayout(windows: false, env: {'HOME': '/home/u', 'QUETZAL_HOME': '  '}).home, '/home/u/.quetzal', reason: '空的环境变量当没设');
      expect(const DesktopLayout(windows: false, env: {}).gatewayToken, isNull);
      expect(const DesktopLayout(windows: false, env: {'HOME': '/home/u'}).root, isNull, reason: 'Linux 没有 ROOT');
    });
    test(r'Windows：缺省 %LOCALAPPDATA%\Quetzal\home', () {
      const l = DesktopLayout(windows: true, env: win);
      expect(l.root, r'C:\Users\u\AppData\Local\Quetzal');
      expect(l.home, r'C:\Users\u\AppData\Local\Quetzal\home');
      expect(l.gatewayToken, r'C:\Users\u\AppData\Local\Quetzal\home\secrets\gateway.token');
      expect(l.consolePointer, r'C:\Users\u\AppData\Local\Quetzal\console\current.txt');
      expect(const DesktopLayout(windows: true, env: {...win, 'QUETZAL_HOME': r'D:\q\'}).gatewayToken, r'D:\q\secrets\gateway.token');
      expect(const DesktopLayout(windows: true, env: {}).gatewayToken, isNull);
    });
  });

  group('版本指针', () {
    test('取第一行、去空白与 BOM；路径与 .. 不算', () {
      expect(parsePointer('1.4.0\r\n'), '1.4.0');
      expect(parsePointer('\uFEFF 1.4.0 '), '1.4.0');
      expect(parsePointer(''), isNull);
      expect(parsePointer(null), isNull);
      expect(parsePointer(r'..\x'), isNull);
      expect(parsePointer('..'), isNull);
      expect(parsePointer(r'C:\evil'), isNull);
    });
    test('Windows：按 console\\current.txt 判断自己是不是旧版本', () {
      const exe = r'C:\Users\u\AppData\Local\Quetzal\console\1.3.1\quetzal-console.exe';
      expect(windowsConsoleStale(exe, '1.3.1\r\n'), isFalse, reason: '指针就是自己');
      expect(windowsConsoleStale(exe, '1.4.0'), isTrue, reason: '安装器装好了新版本、改了指针');
      expect(windowsConsoleStale(exe, null), isFalse, reason: '不是安装器的布局（开发时 flutter run）');
      expect(windowsConsoleStale(r'C:\x\console\1.3.1-RC\quetzal-console.exe', '1.3.1-rc'), isFalse, reason: 'Windows 的目录名不分大小写');
      expect(windowsCurrentConsole(exe, '1.4.0'), r'C:\Users\u\AppData\Local\Quetzal\console\1.4.0\quetzal-console.exe');
      expect(windowsCurrentConsole(exe, ''), isNull);
    });
    test('身体助手的命令：node.txt + runtime\\current.txt', () {
      const l = DesktopLayout(windows: true, env: win);
      expect(l.bodyHelper(nodeTxt: 'C:\\Program Files\\nodejs\\node.exe\r\n', runtimeCurrentTxt: '1.4.0'),
          const BodyHelperCommand(r'C:\Program Files\nodejs\node.exe', r'C:\Users\u\AppData\Local\Quetzal\runtime\1.4.0\windows-body.mjs', '1.4.0'));
      expect(l.bodyHelper(nodeTxt: null, runtimeCurrentTxt: '1.4.0'), isNull);
      expect(l.bodyHelper(nodeTxt: 'node.exe', runtimeCurrentTxt: ''), isNull);
      expect(const DesktopLayout(windows: false, env: {'HOME': '/h'}).bodyHelper(nodeTxt: 'node', runtimeCurrentTxt: '1'), isNull, reason: 'Linux 没有身体助手');
    });
    test('退避：1、2、4…最多 60 秒', () {
      expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => restartBackoff(n).inSeconds).toList(), [1, 1, 2, 4, 8, 16, 32, 60, 60]);
    });
  });

  group('身体助手的看护（Windows）', () {
    late Map<String, String> files;
    late List<(String, List<String>, Map<String, String>)> spawned;
    late List<FakeProcess> procs;
    late List<int> adopted;
    BodyHelper make({bool windows = true}) => BodyHelper(
        layout: DesktopLayout(windows: windows, env: win),
        read: (p) => files[p],
        exists: (_) => true,
        adopt: (pid) async { adopted.add(pid); return true; },
        spawn: (exe, args, env) async { spawned.add((exe, args, env)); final p = FakeProcess(100 + procs.length); procs.add(p); return p; });
    setUp(() {
      files = {r'C:\Users\u\AppData\Local\Quetzal\node.txt': r'C:\node\node.exe', r'C:\Users\u\AppData\Local\Quetzal\runtime\current.txt': '1.4.0'};
      spawned = []; procs = []; adopted = [];
    });

    test('登录时拉起、放进作业对象；崩溃后退避重启；运行基座换版本就换；退出时结束', () {
      fakeAsync((t) {
        final h = make();
        h.start();
        t.flushMicrotasks();
        expect(spawned.single.$1, r'C:\node\node.exe');
        expect(spawned.single.$2, [r'C:\Users\u\AppData\Local\Quetzal\runtime\1.4.0\windows-body.mjs']);
        expect(spawned.single.$3, {'QUETZAL_HOME': r'C:\Users\u\AppData\Local\Quetzal\home'});
        expect(adopted, [100]);
        // 刚起来就崩了：1 秒后重启，再崩 2 秒后……
        procs.last.exit(1); t.flushMicrotasks();
        expect(h.running, isFalse);
        t.elapse(const Duration(milliseconds: 900)); expect(spawned, hasLength(1));
        t.elapse(const Duration(milliseconds: 200)); expect(spawned, hasLength(2));
        procs.last.exit(1); t.flushMicrotasks();
        t.elapse(const Duration(seconds: 1)); expect(spawned, hasLength(2));
        t.elapse(const Duration(seconds: 1)); expect(spawned, hasLength(3));
        // 运行基座升级：current.txt 换了版本，下一次核对时换成新版本的身体助手
        files[r'C:\Users\u\AppData\Local\Quetzal\runtime\current.txt'] = '1.4.1';
        final old = procs.last;
        h.check(); t.flushMicrotasks();
        expect(old.killed, isTrue);
        expect(spawned.last.$2, [r'C:\Users\u\AppData\Local\Quetzal\runtime\1.4.1\windows-body.mjs']);
        h.check(); t.flushMicrotasks();
        expect(spawned, hasLength(4), reason: '版本没变不重启');
        // 托盘「退出」：一起结束，不再拉起
        final last = procs.last;
        h.stop(); t.flushMicrotasks();
        expect(last.killed, isTrue);
        t.elapse(const Duration(minutes: 5));
        expect(spawned, hasLength(4));
      });
    });

    test('还没装好（没有 node.txt）：不拉起，过一会儿再看', () {
      fakeAsync((t) {
        files.remove(r'C:\Users\u\AppData\Local\Quetzal\node.txt');
        final h = make();
        h.start(); t.flushMicrotasks();
        expect(spawned, isEmpty);
        files[r'C:\Users\u\AppData\Local\Quetzal\node.txt'] = r'C:\node\node.exe'; // 安装器写好了
        t.elapse(const Duration(seconds: 2));
        expect(spawned, hasLength(1));
      });
    });

    test('Linux 上什么都不做', () {
      fakeAsync((t) {
        make(windows: false).start(); t.elapse(const Duration(minutes: 1));
        expect(spawned, isEmpty);
      });
    });
  });
}
