// 原生桌面控制台（Linux / Windows）才有的本机能力：读家目录里的网关令牌、看护 Windows 的身体助手。网页版为空实现。
export 'desktop_web.dart' if (dart.library.io) 'desktop_io.dart';
