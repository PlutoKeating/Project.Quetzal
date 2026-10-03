// 听觉桥：控制台当这具身体的耳朵（MethodChannel windler/hearing、EventChannel windler/hearing/events）。
//   原生的 HearingService 常驻麦克风、系统降噪、WebRTC VAD 断句，把每句话直接 POST 到本机网关 /hear；这里只负责按基座的意愿启停它。
//   基座的 status.hearing.listening 为真（开关开着、未急停、电量与温度在限制内、Azure 语音已配置）且 agent 在本机（127.0.0.1）时开耳朵，否则关。
//   服务事件（说话开始 / 结束、识别结果、错误）只用于界面提示：首页光团旁的「在听」、听觉页的最近一句。
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'api.dart';

class Hearing {
  static const _ch = MethodChannel('windler/hearing');
  static const _ev = EventChannel('windler/hearing/events');
  static Stream<Map<String, dynamic>>? _events;
  static Stream<Map<String, dynamic>> get events => _events ??= _ev.receiveBroadcastStream().map((e) => Map<String, dynamic>.from(e as Map)).asBroadcastStream();

  static Future<bool> hasPermission() async { try { return await _ch.invokeMethod<bool>('hasPermission') ?? false; } catch (_) { return false; } }
  static Future<void> requestPermission() => _ch.invokeMethod('requestPermission');
  static Future<bool> isRunning() async { try { return await _ch.invokeMethod<bool>('isRunning') ?? false; } catch (_) { return false; } }
  static Future<void> start({required String base, required String token, required int sensitivity}) => _ch.invokeMethod('start', {'base': base, 'token': token, 'sensitivity': sensitivity});
  static Future<void> stop() => _ch.invokeMethod('stop');
}

/// 跟随基座状态启停耳朵，并保留最近的事件给界面。
class HearingController extends ChangeNotifier {
  bool running = false, granted = false, speaking = false;
  String? error;
  Map? lastHeard; // {text, dropped, ms}
  String _key = ''; // 上次启动的参数（base|token|sensitivity），变了就重启
  Timer? _speakTimer;

  void start() {
    api.addListener(sync);
    Hearing.events.listen(_onEvent, onError: (_) {});
    refreshPermission().then((_) => sync());
  }

  Future<bool> refreshPermission() async { granted = await Hearing.hasPermission(); running = await Hearing.isRunning(); notifyListeners(); return granted; }

  static bool local(String base) => base.contains('127.0.0.1') || base.contains('localhost');

  /// 基座想听、本机有权限、agent 在本机 → 开；否则关。
  Future<void> sync() async {
    final h = (api.status['hearing'] as Map?) ?? {};
    final want = h['listening'] == true && api.conn == Conn.online && granted && local(api.base);
    final key = '${api.base}|${api.token}|${h['sensitivity'] ?? 2}';
    try {
      if (want && (!running || key != _key)) {
        await Hearing.start(base: api.base, token: api.token, sensitivity: ((h['sensitivity'] ?? 2) as num).toInt());
        _key = key; running = true; error = null;
      } else if (!want && running) {
        await Hearing.stop();
        running = false;
      }
    } catch (e) { error = '$e'; }
    notifyListeners();
  }

  void _onEvent(Map<String, dynamic> e) {
    switch (e['kind']) {
      case 'state': running = e['running'] == true; if (!running) speaking = false;
      case 'speech':
        speaking = e['on'] == true;
        _speakTimer?.cancel();
        if (!speaking) { speaking = true; _speakTimer = Timer(const Duration(milliseconds: 1200), () { speaking = false; notifyListeners(); }); } // 说完后再亮一会儿
      case 'heard': lastHeard = e; error = null;
      case 'error': error = '${e['message']}';
    }
    notifyListeners();
  }
}

final hearing = HearingController();
