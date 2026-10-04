// dart:io 平台（安卓 App、Linux 桌面版）。
import 'dart:io';

const isWeb = false;
/// 有身体：能安装 / 点火 / 当耳朵（只有安卓 App；桌面版的身体是运行基座的 Linux 适配器，控制台不参与）。
final bool hasBody = Platform.isAndroid;
/// 原生桌面版（Linux / macOS / Windows）：没有页面来源，但连本机网关可以免配对码。
final bool isDesktop = Platform.isLinux || Platform.isMacOS || Platform.isWindows;
