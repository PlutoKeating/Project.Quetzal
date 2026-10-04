// 这次构建跑在哪里，决定哪些「身体」功能可用。
//   安卓 App：安装器（把运行基座装进本机 Termux）、点火、耳朵与播放器——都靠原生代码与 Termux。
//   网页版（由运行基座的网关托管，在电脑浏览器里打开）：纯前端，没有身体功能；连谁由页面来源决定（见 location.dart）。
//   Linux 桌面版（flutter build linux，一键安装脚本放到 ~/.quetzal/console/）：同样只是管理前端；连本机网关时免配对码（GET /auth/local 对回环连接放行）。
// 条件导入：网页编译 caps_web.dart，其余（安卓、Linux 桌面）编译 caps_io.dart 按运行平台判断。
export 'caps_io.dart' if (dart.library.js_interop) 'caps_web.dart';
