// 桌面版（Linux）的托盘图标：代表后台的运行基座，不是控制台窗口——运行基座在跑就在，与窗口开没开无关。
//   控制台是单实例（linux/runner/my_application.cc）：登录桌面时以 --background 启动（只起托盘、不开窗口），
//   之后从应用列表再点 Quetzal 只是把这个实例的窗口提到最前；关窗只是隐藏窗口，进程与托盘都在。
//   托盘图标只在运行基座连得上时显示：连不上超过 20 秒（停了、退出了）就收起，回来了再显示（升级时重启服务的几秒不会闪）。
//   菜单：打开 Quetzal（没有窗口就打开，有就提到最前并获得焦点）、急停 · 本机、急停 · 全部设备、退出（让运行基座停掉后台服务，整个 Quetzal 退出）。
//   Linux 的状态栏图标（AppIndicator）单击就是弹出菜单、没有单击 / 双击事件；tray_manager 在 Linux 上只实现了
//   setIcon / setContextMenu / setTitle / destroy（不调 setToolTip，会抛异常）。底层 libayatana-appindicator3。
import 'dart:async';
import 'dart:io' show Platform, exit;
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';
import '../api.dart';

bool _supported = false; // 这台桌面能起托盘（第一次显示成功过）
bool _shown = false;     // 托盘图标此刻在不在
String _last = '';
Timer? _gone;            // 运行基座连不上之后的宽限计时

/// 起托盘。background：以 --background 启动（只起托盘、不开窗口）。返回窗口管理是否就绪。
Future<bool> initTray({bool background = false}) async {
  if (!Platform.isLinux) return false;
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
    _gone?.cancel(); _gone = null;
    if (!_shown) await _show();
    await _menu();
  } else if (_shown && _gone == null) {
    _gone = Timer(const Duration(seconds: 20), () async { _gone = null; if (api.conn != Conn.online) await _hideTray(); });
  }
}

Future<void> _show() async {
  try {
    await trayManager.setIcon('assets/tray/icon.png');
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
  try { await windowManager.setPreventClose(false); } catch (_) {}
  exit(0);
}

class _TrayEvents with TrayListener {
  // Linux 的 AppIndicator 单击直接弹菜单，不会走到这里；其他桌面（macOS / Windows）单击弹出菜单
  @override
  void onTrayIconMouseDown() { if (!Platform.isLinux) trayManager.popUpContextMenu(); }
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
