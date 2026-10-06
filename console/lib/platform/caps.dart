// 这次构建跑在哪里，决定哪些「身体」功能可用。
//   安卓 App：安装器（启动 App 内置的运行基座）、点火、身体、耳朵与播放器——都靠原生代码。
//   网页版（由运行基座的网关托管，在电脑浏览器里打开）：纯前端，没有身体功能；连谁由页面来源决定（见 location.dart）。
//   桌面版（Linux：flutter build linux，一键安装脚本放到 ~/.quetzal/console/；Windows：flutter build windows，安装器放到 %LOCALAPPDATA%\Quetzal\console\）：
//     管理前端 + 托盘 + 耳朵与播放器；连本机网关免配对码（读家目录里的网关令牌，或 GET /auth/local）。Windows 上托盘进程还看护身体助手。
// 条件导入：网页编译 caps_web.dart，其余（安卓、Linux / Windows 桌面）编译 caps_io.dart 按运行平台判断。
export 'caps_io.dart' if (dart.library.js_interop) 'caps_web.dart';
