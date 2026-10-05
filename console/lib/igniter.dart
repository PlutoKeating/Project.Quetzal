// 运行基座桥：控制台与 App 内置的运行基座之间的原生交互（MethodChannel quetzal/runtime）。
//   只装一个 App：Node.js、git、ssh、proot 随 APK 一起安装（见 tool/android-runtime/），运行基座在 App 自己的前台服务里运行（RuntimeService）。
//   点火 = 启动前台服务；升级 = 重启它（新版 App 带着新版运行基座，重启即升级）；网关令牌直接从家目录读取，同一台手机不需要配对码。
//   另有身体权限（相机、麦克风、定位、通知）与保活（电池优化、厂商自启动管理）。
import 'package:flutter/services.dart';

class Igniter {
  static const _ch = MethodChannel('quetzal/runtime');

  /// 这个 App 里有没有内置运行环境（开发版可能没有）。
  static Future<bool> available() async { try { return await _ch.invokeMethod<bool>('bundled') ?? false; } catch (_) { return false; } }
  /// {installed, running, version, error}
  static Future<Map> status() async { try { return await _ch.invokeMethod<Map>('status') ?? {}; } catch (_) { return {}; } }
  /// 网关令牌（运行基座第一次启动后才有）。
  static Future<String?> token() async { try { return await _ch.invokeMethod<String>('token'); } catch (_) { return null; } }
  static Future<void> restart() => _ch.invokeMethod('restart');
  static Future<void> stop() => _ch.invokeMethod('stop');

  /// 点火：启动前台服务（已在运行则无事）。返回 null 表示已启动；否则返回原因。
  static Future<String?> ignite() async {
    if (!await available()) return '这个 App 没有内置运行基座（开发版）';
    try { await _ch.invokeMethod('start'); return null; } on PlatformException catch (e) { return '点火失败：${e.message}'; }
  }

  /// 身体权限：{camera, microphone, location, notifications} → 是否已授权。
  static Future<Map<String, bool>> bodyPermissions() async {
    try { return Map<String, bool>.from(await _ch.invokeMethod<Map>('bodyPermissions') ?? {}); } catch (_) { return {}; }
  }
  /// 请求身体权限（系统弹窗）。授权后重启前台服务，让它带上相应的前台服务类型（后台使用相机、麦克风、定位的前提）。
  static Future<void> requestBodyPermissions() => _ch.invokeMethod('requestBodyPermissions');

  /// 系统的「忽略电池优化」列表。
  static Future<void> openBatterySettings() => _ch.invokeMethod('openBatterySettings');
  /// 请求把本应用加入忽略电池优化（系统弹窗）。
  static Future<void> requestIgnoreBattery() => _ch.invokeMethod('requestIgnoreBattery');
  /// 各厂商的「自启动 / 后台运行」管理页；找不到时打开本应用的详情页。
  static Future<void> openAutostart() => _ch.invokeMethod('openAutostart');
}
