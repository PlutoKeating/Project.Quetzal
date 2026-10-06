import 'package:flutter/foundation.dart' show ValueNotifier;

/// 网页版：没有托盘。
Future<bool> initTray({bool background = false}) async => false;
Future<void> openWindow() async {}
final consoleStale = ValueNotifier(false);
Future<void> relaunchConsole({bool background = false}) async {}
bool consoleIsStale() => false;
