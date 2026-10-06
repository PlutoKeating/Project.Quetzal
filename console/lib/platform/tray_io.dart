// 桌面版（Linux）的托盘图标：右上角状态栏里一个 Quetzal 图标（tray_manager，底层 libayatana-appindicator3）。
//   菜单：ta 的名字与此刻的状态（醒着 / 睡着 / 急停中 / 离线）、显示或隐藏窗口、急停（已急停时是「解除急停…」，打开窗口去确认）、退出控制台。
//   有托盘时，点窗口的关闭按钮只是收进托盘（运行基座本来就在后台跑，控制台随时再打开）；托盘起不来（桌面不支持状态栏图标）时照常关闭。
//   Linux 的状态栏图标单击就是弹出菜单，所以「显示 / 隐藏窗口」放在菜单里。
import 'dart:io' show Platform, exit;
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';
import '../api.dart';
import '../pages/home.dart' show presenceMode;

bool _ready = false;
String _last = '';

/// 起托盘。返回是否成功（不成功时关窗照常退出）。
Future<bool> initTray() async {
  if (!Platform.isLinux || _ready) return _ready;
  try {
    await windowManager.ensureInitialized();
    await trayManager.setIcon('assets/tray/icon.png');
    await trayManager.setToolTip('Quetzal');
    trayManager.addListener(_TrayEvents());
    windowManager.addListener(_WindowEvents());
    await windowManager.setPreventClose(true);
    _ready = true;
    api.addListener(_refresh);
    await _refresh(force: true);
  } catch (_) {
    _ready = false;
    try { await windowManager.setPreventClose(false); } catch (_) {}
  }
  return _ready;
}

String _state() {
  if (api.conn != Conn.online) return {Conn.connecting: '连接中', Conn.igniting: '正在启动', Conn.offline: '离线', Conn.unpaired: '未配对'}[api.conn] ?? '离线';
  return presenceMode().label;
}

/// 菜单只在内容变了时重建（api 每次心跳都会通知）。
Future<void> _refresh({bool force = false}) async {
  if (!_ready) return;
  final visible = await windowManager.isVisible();
  final status = '${api.name} · ${_state()}';
  final key = '$status|$visible|${api.stopped}|${api.conn}';
  if (!force && key == _last) return;
  _last = key;
  await trayManager.setToolTip(status);
  await trayManager.setContextMenu(Menu(items: [
    MenuItem(key: 'status', label: status, disabled: true),
    MenuItem.separator(),
    MenuItem(key: 'toggle', label: visible ? '隐藏窗口' : '打开 Quetzal'),
    MenuItem(key: 'stop', label: api.stopped ? '解除急停…' : '急停', disabled: api.conn != Conn.online),
    MenuItem.separator(),
    MenuItem(key: 'quit', label: '退出控制台（ta 照常在后台）'),
  ]));
}

Future<void> _show() async { await windowManager.show(); await windowManager.focus(); await _refresh(); }
Future<void> _hide() async { await windowManager.hide(); await _refresh(); }

class _TrayEvents with TrayListener {
  @override
  void onTrayIconMouseDown() => trayManager.popUpContextMenu();
  @override
  void onTrayMenuItemClick(MenuItem item) async {
    switch (item.key) {
      case 'toggle':
        await windowManager.isVisible() ? await _hide() : await _show();
      case 'stop':
        // 急停不需要确认，越快越好；有几具身体在线时停所有身体。解除要确认：打开窗口，在那里点
        if (api.stopped) { await _show(); return; }
        try { await api.call('stop', {'reason': '托盘急停', if (api.peers.isNotEmpty) 'scope': 'all'}); } catch (_) {}
      case 'quit':
        await trayManager.destroy();
        await windowManager.setPreventClose(false);
        exit(0);
    }
  }
}

class _WindowEvents with WindowListener {
  @override
  void onWindowClose() => _hide(); // 关窗 = 收进托盘
}
