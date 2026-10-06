// dart:io 平台（安卓 App、Linux / Windows 桌面版）。
import 'dart:io';

const isWeb = false;
/// 有身体：能安装 / 点火 / 提供身体接口（只有安卓 App；桌面版的身体是运行基座的适配器，Windows 上另有托盘看护的身体助手）。
/// 耳朵不看这个：安卓与桌面版都能当耳朵（hearing.dart 的 HearingController.canHear）。
final bool hasBody = Platform.isAndroid;
/// 原生桌面版（Linux / macOS / Windows）：没有页面来源，但连本机网关可以免配对码。
final bool isDesktop = Platform.isLinux || Platform.isMacOS || Platform.isWindows;
