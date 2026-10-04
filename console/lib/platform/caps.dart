// 这次构建跑在哪里，决定哪些「身体」功能可用。
//   安卓 App：安装器（把运行基座装进本机 Termux）、点火、耳朵与播放器——都靠原生代码与 Termux。
//   网页版（由运行基座的网关托管，在电脑浏览器里打开）：纯前端，没有身体功能；连谁由页面来源决定（见 location.dart）。
import 'package:flutter/foundation.dart' show kIsWeb;

const isWeb = kIsWeb;

/// 有身体：能安装 / 点火 / 当耳朵（只有安卓 App）。
const hasBody = !kIsWeb;
