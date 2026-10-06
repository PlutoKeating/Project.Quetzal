// 桌面版的托盘图标：网页版与安卓没有（空实现），桌面版见 tray_io.dart。
export 'tray_stub.dart' if (dart.library.io) 'tray_io.dart';
