// 桌面版（Linux / Windows）的耳朵与播放器：在控制台进程里采集麦克风、断句、流式送到本机网关 /hear，播放她的声音。网页版为空实现。
export 'ear_web.dart' if (dart.library.io) 'ear_io.dart';
