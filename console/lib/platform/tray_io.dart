// 桌面版（Linux / Windows）的托盘图标：代表后台的运行基座，不是控制台窗口——运行基座在跑就在，与窗口开没开无关。
//   控制台是单实例（linux/runner/my_application.cc；windows/runner/main.cpp：命名互斥量 + 激活已在运行的窗口）：
//   登录桌面时以 --background 启动（只起托盘、不开窗口；Linux 是桌面自启动项，Windows 是 HKCU\…\Run），
//   之后从应用列表再点 Quetzal 只是把这个实例的窗口提到最前；关窗只是隐藏窗口，进程与托盘都在。
//   托盘图标只在运行基座连得上时显示：连不上超过 20 秒（停了、退出了）就收起，回来了再显示（升级时重启服务的几秒不会闪）。
//   菜单：打开 Quetzal（没有窗口就打开，有就提到最前并获得焦点）、急停 · 本机、急停 · 全部设备、退出（让运行基座停掉后台服务，整个 Quetzal 退出）。
//   Linux 的状态栏图标（AppIndicator）单击就是弹出菜单、没有单击 / 双击事件；tray_manager 在 Linux 上只实现了
//   setIcon / setContextMenu / setTitle / destroy（不调 setToolTip，会抛异常）。底层 libayatana-appindicator3。
//   Windows 的通知区域图标要 .ico（assets/tray/icon.ico，与 Linux 的 png 同一个球）；按 Windows 的习惯左键打开窗口、右键弹出菜单，悬停提示 Quetzal。
//   换新版本：安装器把新控制台装到 console/<版本>/ 再改指针，但单实例让正在跑的旧进程留了下来。
//     Linux：current 是符号链接，旧目录被删掉（/proc 里可执行文件带 (deleted)）；
//     Windows：console\current.txt 一行写着当前版本（正在运行的 exe 删不掉，只能按指针比较自己所在的版本目录）。
//   这里每分钟（以及运行基座重新连上时）看一眼自己的可执行文件还是不是当前版本：不是了——窗口没开就悄悄换成新版本（--replace --background），
//   窗口开着就把 consoleStale 置真，外壳给一条「新版本已装好 · 重新打开」，不打断正在看的人。
//   Windows 上托盘进程还看护身体助手（desktop_io.dart 的 BodyHelper）：随托盘起来、每分钟核对版本、「退出」时一起结束。
import 'dart:async';
import 'dart:io' show Directory, File, Platform, Process, ProcessStartMode, exit;
import 'package:flutter/foundation.dart' show ValueNotifier, debugPrint, visibleForTesting;
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';
import '../api.dart';
import 'desktop.dart' show BodyHelper;
import 'desktop_paths.dart';

bool _supported = false; // 这台桌面能起托盘（第一次显示成功过）
bool _shown = false;     // 托盘图标此刻在不在
String _last = '';
Timer? _gone;            // 运行基座连不上之后的宽限计时
Timer? _staleCheck;

/// 磁盘上已经装好了更新的控制台，正在跑的是旧的（窗口开着时由外壳提示「重新打开」）。
final consoleStale = ValueNotifier(false);

bool get _supportedPlatform => Platform.isLinux || Platform.isWindows;

/// 正在跑的可执行文件已经不是当前版本（Linux：被删了，或 current 指到了别的版本目录；Windows：console\current.txt 写的是别的版本）。
/// 不是安装器的目录布局时为假。
bool consoleIsStale() => _supportedPlatform && _isStale();
bool _isStale() => Platform.isWindows ? _windowsStale() : staleExecutable(Platform.resolvedExecutable);

String? _consolePointer(String exe) { try { return File('${parentDir(parentDir(exe))}\\current.txt').readAsStringSync(); } catch (_) { return null; } }
bool _windowsStale() { final exe = Platform.resolvedExecutable; return windowsConsoleStale(exe, _consolePointer(exe)); }

/// [exe] 是不是旧版本（测试用：传入任意路径）。
@visibleForTesting
bool staleExecutable(String exe) {
  if (exe.endsWith(' (deleted)')) return true;
  final dir = File(exe).parent, current = Directory('${dir.parent.path}/current');
  if (!current.existsSync()) return false;
  try { return current.resolveSymbolicLinksSync() != dir.resolveSymbolicLinksSync(); } catch (_) { return false; }
}

/// 换成新版本：启动当前版本的控制台接管单实例（--replace），等它真的起来再退出自己。background：只起托盘、不开窗口。
Future<void> relaunchConsole({bool background = false}) async {
  final exe = Platform.resolvedExecutable;
  final next = Platform.isWindows
      ? windowsCurrentConsole(exe, _consolePointer(exe))
      : '${File(exe.replaceFirst(' (deleted)', '')).parent.parent.path}/current/quetzal-console';
  if (next == null || !File(next).existsSync()) return;
  await Process.start(next, ['--replace', if (background) '--background'], mode: ProcessStartMode.detached);
  exit(0);
}

Future<void> _checkStale() async {
  if (!_isStale()) return;
  bool visible = true;
  try { visible = await windowManager.isVisible(); } catch (_) {}
  if (!visible) { try { await relaunchConsole(background: true); } catch (e) { debugPrint('换新版本失败：$e'); } }
  consoleStale.value = true;
}

/// 起托盘。background：以 --background 启动（只起托盘、不开窗口）。返回窗口管理是否就绪。
Future<bool> initTray({bool background = false}) async {
  if (!_supportedPlatform) return false;
  BodyHelper.instance.start(); // Windows：拉起并看护身体助手（Linux 上什么都不做）
  _staleCheck ??= Timer.periodic(const Duration(minutes: 1), (_) { _checkStale(); BodyHelper.instance.check(); }); // 起不来托盘也照样检查
  try {
    await windowManager.ensureInitialized();
    trayManager.addListener(_TrayEvents());
    windowManager.addListener(_WindowEvents());
    api.addListener(_onApi);
    await _onApi();
    return true;
  } catch (e) {
    debugPrint('托盘起不来：$e');
    return false;
  }
}

/// 运行基座连得上就显示托盘、连不上超过 20 秒就收起。
Future<void> _onApi() async {
  if (api.conn == Conn.online) {
    if (_gone != null || !_shown) unawaited(_checkStale()); // 运行基座重新连上（升级时会重启一次）：看看控制台是不是也换了新版本
    _gone?.cancel(); _gone = null;
    if (!_shown) await _show();
    await _menu();
  } else if (_shown && _gone == null) {
    _gone = Timer(const Duration(seconds: 20), () async { _gone = null; if (api.conn != Conn.online) await _hideTray(); });
  }
}

Future<void> _show() async {
  try {
    await trayManager.setIcon(Platform.isWindows ? 'assets/tray/icon.ico' : 'assets/tray/icon.png');
    if (Platform.isWindows) await trayManager.setToolTip('Quetzal'); // Linux 的 AppIndicator 不支持，调了会抛异常
    _shown = true; _last = '';
    await _menu();
    if (!_supported) { _supported = true; await windowManager.setPreventClose(true); } // 有托盘了：关窗只是隐藏
  } catch (e) {
    debugPrint('托盘起不来：$e');
    _shown = false;
  }
}

Future<void> _hideTray() async {
  try { await trayManager.destroy(); } catch (_) {}
  _shown = false;
}

/// 菜单只在内容变了时重建（api 每次心跳都会通知）。
Future<void> _menu() async {
  if (!_shown) return;
  final online = api.conn == Conn.online;
  final key = '$online';
  if (key == _last) return;
  _last = key;
  await trayManager.setContextMenu(Menu(items: [
    MenuItem(key: 'open', label: '打开 Quetzal'),
    MenuItem.separator(),
    MenuItem(key: 'stop.body', label: '急停 · 本机', disabled: !online),
    MenuItem(key: 'stop.all', label: '急停 · 全部设备', disabled: !online),
    MenuItem.separator(),
    MenuItem(key: 'quit', label: '退出'),
  ]));
}

/// 没有窗口就打开，有就提到最前并获得焦点。
Future<void> openWindow() async {
  await windowManager.show();
  await windowManager.focus();
}

Future<void> _quit() async {
  // 让运行基座停掉后台服务（systemd 用户服务 stop；守护循环这次不再拉起），然后整个 Quetzal 退出
  try { if (api.conn == Conn.online) await api.call('quit').timeout(const Duration(seconds: 5)); } catch (_) {}
  await _hideTray();
  await BodyHelper.instance.stop();
  try { await windowManager.setPreventClose(false); } catch (_) {}
  exit(0);
}

class _TrayEvents with TrayListener {
  // Linux 的 AppIndicator 单击直接弹菜单，不会走到这里。Windows：左键打开窗口、右键弹出菜单；macOS：单击弹出菜单
  @override
  void onTrayIconMouseDown() { if (Platform.isWindows) { openWindow(); } else if (!Platform.isLinux) { trayManager.popUpContextMenu(); } }
  @override
  void onTrayIconRightMouseDown() { if (Platform.isWindows) trayManager.popUpContextMenu(); }
  @override
  void onTrayMenuItemClick(MenuItem item) async {
    switch (item.key) {
      case 'open': await openWindow();
      case 'stop.body': try { await api.call('stop', {'reason': '托盘急停（本机）', 'scope': 'body'}); } catch (_) {}
      case 'stop.all': try { await api.call('stop', {'reason': '托盘急停（全部设备）', 'scope': 'all'}); } catch (_) {}
      case 'quit': await _quit();
    }
  }
}

class _WindowEvents with WindowListener {
  @override
  void onWindowClose() { if (_supported) windowManager.hide(); } // 关窗 = 隐藏窗口；托盘与进程都在
}
