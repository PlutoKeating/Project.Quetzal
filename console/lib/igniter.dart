// Termux 桥：控制台与同一台手机上的 Termux 之间的全部原生交互（MethodChannel windler/igniter）。
//   点火（启动运行基座服务）、安装器下发命令、检测三件套、打开系统设置里的保活页面。
//   命令通过 Termux 的 RUN_COMMAND 接口执行，前提是 Termux 的 ~/.termux/termux.properties 里 allow-external-apps=true，
//   且本应用已获「在 Termux 中运行命令」权限（系统弹窗）。
import 'package:flutter/services.dart';

class Igniter {
  static const _ch = MethodChannel('windler/igniter');
  static const prefix = '/data/data/com.termux/files/usr';
  static const home = '/data/data/com.termux/files/home';
  static const termux = 'com.termux', termuxApi = 'com.termux.api', termuxBoot = 'com.termux.boot';

  /// 三件套的版本号；没装返回 null。
  static Future<String?> version(String pkg) async { try { return await _ch.invokeMethod<String>('packageVersion', {'pkg': pkg}); } catch (_) { return null; } }
  static Future<bool> available() async => (await version(termux)) != null;
  static Future<bool> hasPermission() async { try { return await _ch.invokeMethod<bool>('hasPermission') ?? false; } catch (_) { return false; } }
  static Future<void> requestPermission() => _ch.invokeMethod('requestPermission');
  static Future<void> openTermux() => _ch.invokeMethod('openApp', {'pkg': termux});
  static Future<void> openApp(String pkg) => _ch.invokeMethod('openApp', {'pkg': pkg});
  static Future<void> openAppDetails(String pkg) => _ch.invokeMethod('openAppDetails', {'pkg': pkg});
  /// 系统的「忽略电池优化」列表（用户在里面找到 Termux 与 Windler 放行）。
  static Future<void> openBatterySettings() => _ch.invokeMethod('openBatterySettings');
  /// 请求把本应用加入忽略电池优化（系统弹窗）。
  static Future<void> requestIgnoreBattery() => _ch.invokeMethod('requestIgnoreBattery');
  /// 各厂商的「自启动 / 后台运行」管理页；找不到时打开 Termux 的应用详情。
  static Future<void> openAutostart() => _ch.invokeMethod('openAutostart');

  /// 在 Termux 里后台执行一个程序。只负责发出指令，不等待结果（结果由程序自己回报，见 installer.dart）。
  static Future<void> run(String path, List<String> args) => _ch.invokeMethod('run', {'path': path, 'args': args});
  static Future<void> bash(String script) => run('$prefix/bin/bash', ['-c', script]);

  /// 点火：重新执行开机脚本（唤醒锁 + runit），再拉起 windler 服务。返回 null 表示已发出指令；否则返回原因。
  static Future<String?> ignite() async {
    if (!await available()) return '没有安装 Termux，无法自动点火';
    if (!await hasPermission()) { await requestPermission(); return '请先允许「在 Termux 中运行命令」权限，然后再点一次'; }
    try {
      await run('$home/.termux/boot/windler', <String>[]);
      await run('$prefix/bin/sv', ['up', '$prefix/var/service/windler']);
      return null;
    } on PlatformException catch (e) {
      return '点火失败：${e.message}（请确认 Termux 设置中 allow-external-apps=true）';
    }
  }
}
