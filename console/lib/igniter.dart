// 点火器：通过 Termux 的 RUN_COMMAND 接口启动 Amani 服务（仅 Android + Termux 部署时可用）。
import 'package:flutter/services.dart';

class Igniter {
  static const _ch = MethodChannel('amani/igniter');
  static const prefix = '/data/data/com.termux/files/usr';
  static const home = '/data/data/com.termux/files/home';

  static Future<bool> available() async { try { return await _ch.invokeMethod<bool>('termuxInstalled') ?? false; } catch (_) { return false; } }
  static Future<bool> hasPermission() async { try { return await _ch.invokeMethod<bool>('hasPermission') ?? false; } catch (_) { return false; } }
  static Future<void> requestPermission() => _ch.invokeMethod('requestPermission');
  static Future<void> openTermux() => _ch.invokeMethod('openTermux');

  /// 返回 null 表示已发出点火指令；否则返回原因。
  static Future<String?> ignite() async {
    if (!await available()) return '没有安装 Termux，无法自动点火';
    if (!await hasPermission()) { await requestPermission(); return '请先允许「在 Termux 中运行命令」权限，然后再点一次'; }
    try {
      // 重新执行开机脚本：保持唤醒 + 启动 runit（Amani 由其守护），幂等
      await _ch.invokeMethod('run', {'path': '$home/.termux/boot/amani', 'args': <String>[]});
      await _ch.invokeMethod('run', {'path': '$prefix/bin/sv', 'args': ['up', '$prefix/var/service/amani']});
      return null;
    } on PlatformException catch (e) {
      return '点火失败：${e.message}（请确认 Termux 设置中 allow-external-apps=true）';
    }
  }
}
