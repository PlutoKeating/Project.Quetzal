// 听觉：控制台当这具身体的耳朵。
//   安卓：原生的 HearingService 常驻麦克风、系统降噪与回声消除、WebRTC VAD 断句，把每句话直接 POST 到本机网关 /hear
//         （MethodChannel quetzal/hearing、EventChannel quetzal/hearing/events）；这里只负责按基座的意愿启停它。
//   桌面版（Linux / Windows）：控制台进程里的 DesktopEar（platform/ear_io.dart）做同样的事；没有系统回声消除，她说话时耳朵不送音频、不能插嘴。
//   基座的 status.hearing.listening 为真（开关开着、未急停、电量与温度在限制内、Azure 语音已配置）且 agent 在本机（127.0.0.1）时开耳朵，否则关。
//   耳朵开着时向基座登记为播放器（player.set），她的声音（speak 事件）由这里播放，播完回报 player.done。
//   事件（说话开始 / 结束、识别结果、错误）只用于界面提示：首页光团旁的「在听」、声音页的最近一句。
import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'api.dart';
import 'platform/caps.dart';
import 'platform/ear.dart';

class Hearing {
  static const _ch = MethodChannel('quetzal/hearing');
  static const _ev = EventChannel('quetzal/hearing/events');
  static Stream<Map<String, dynamic>>? _events;
  static Stream<Map<String, dynamic>> get events => _events ??= _ev.receiveBroadcastStream().map((e) => Map<String, dynamic>.from(e as Map)).asBroadcastStream();

  static Future<bool> hasPermission() async { try { return await _ch.invokeMethod<bool>('hasPermission') ?? false; } catch (_) { return false; } }
  static Future<void> requestPermission() => _ch.invokeMethod('requestPermission');
  static Future<bool> isRunning() async { try { return await _ch.invokeMethod<bool>('isRunning') ?? false; } catch (_) { return false; } }
  /// fingerprint：base 为 https 时钉住的证书指纹（原生服务只认这张证书）；本机明文连接为空。
  static Future<void> start({required String base, required String token, required String fingerprint, required int sensitivity}) => _ch.invokeMethod('start', {'base': base, 'token': token, 'fingerprint': fingerprint, 'sensitivity': sensitivity});
  static Future<void> stop() => _ch.invokeMethod('stop');
  /// 播放她的一段合成语音（走通话路径，耳朵以它为回声参考）；播完或被插嘴后以 played 事件回报。
  static Future<bool> play(String id, String url) async { try { return await _ch.invokeMethod<bool>('play', {'id': id, 'url': url}) ?? false; } catch (_) { return false; } }
  static Future<void> stopPlayback() => _ch.invokeMethod('stopPlayback');
}

/// 跟随基座状态启停耳朵，并保留最近的事件给界面。
class HearingController extends ChangeNotifier {
  bool running = false, granted = false, speaking = false, pending = false; // pending：一句话刚说完，基座正在识别
  bool playing = false; // 正在播放她的声音
  String? error;
  Map? lastHeard; // {text, dropped, ms}
  String _key = ''; // 上次启动的参数（base|token|sensitivity），变了就重启
  bool _registered = false; // 已向基座登记为播放器
  Timer? _speakTimer, _pendingTimer;
  String _failedKey = ''; // 桌面版：按这组参数开耳朵失败过（没有录音程序、没有麦克风权限…），一分钟内不再反复试
  int _failedAt = 0;
  bool _busy = false, _again = false;

  /// 这台设备能当耳朵：安卓 App 与桌面版（Linux / Windows）；网页版没有麦克风，只跟着状态显示。
  static bool get canHear => hasBody || DesktopEar.supported;
  static bool get _desktop => !hasBody && DesktopEar.supported;

  /// 给界面的一句话：此刻耳朵的状态；没开听觉时返回 null。
  String? get caption {
    final h = (api.status['hearing'] as Map?) ?? {};
    if (h['enabled'] != true) return null;
    if (!canHear) return h['listening'] == true ? '耳朵在 App 上，在听' : '耳朵在 App 上，此刻没开';
    if (!running) { final r = (h['reasons'] as List?)?.cast<String>() ?? []; return r.isEmpty ? (granted ? '耳朵没开' : '耳朵没开：没有麦克风权限') : '没在听：${r.join('、')}'; }
    if (DateTime.now().millisecondsSinceEpoch < speakingUntil) return hasBody ? '她在说话（可以直接插嘴）' : '她在说话';
    if (speaking) return '有人在说话…';
    if (pending) return '听到了，正在听清…';
    return '在听';
  }
  bool get lit => running && DateTime.now().millisecondsSinceEpoch >= speakingUntil && (speaking || pending);

  int speakingUntil = 0; // 她在说话到这个时刻（毫秒）
  Timer? _speakingTimer;

  void start() {
    api.addListener(sync);
    if (hasBody) Hearing.events.listen(_onEvent, onError: (_) {});
    if (_desktop) DesktopEar.instance.events.listen(_onEvent, onError: (_) {});
    api.events.where((e) => e.name == 'speaking').listen((e) { // 她在说话到 until 为止（对方插嘴时基座会把 until 提前到现在）
      final until = ((e.data as Map)['until'] as num).toInt();
      speakingUntil = until; speaking = false; pending = false;
      DesktopEar.instance.mutedUntil = until; // 桌面版：这段时间耳朵不送（麦克风里多半是她自己的声音）
      final ms = until - DateTime.now().millisecondsSinceEpoch + 100;
      _speakingTimer?.cancel();
      if (ms > 0) _speakingTimer = Timer(Duration(milliseconds: ms), notifyListeners);
      notifyListeners();
    });
    api.events.where((e) => e.name == 'speak').listen((e) async { // 她要说话：由本机播放（安卓的回声消除需要声音从这里出来）
      final s = e.data as Map;
      if (!running) return;
      // 令牌由耳朵自己放在请求头里（它启动时已拿到），不拼进网址
      final url = '${api.base}${s['url']}';
      final ok = hasBody ? await Hearing.play('${s['id']}', url) : await DesktopEar.instance.play('${s['id']}', url);
      if (!ok) api.call('player.done', {'id': s['id'], 'interrupted': false}).catchError((_) => null); // 放不了：让基座别等
    });
    api.events.where((e) => e.name == 'hearing').listen((e) { // 基座确认听到了对方（含插嘴）：亮起来
      final h = e.data as Map;
      if (h['status'] == 'partial' || h['status'] == 'final') { speaking = h['status'] == 'partial'; pending = h['status'] == 'final'; notifyListeners(); }
      if (h['status'] == 'kept' || h['status'] == 'ignored' || h['status'] == 'dropped') { pending = false; notifyListeners(); }
    });
    if (!canHear) return;
    if (hasBody) AppLifecycleListener(onResume: () => refreshPermission().then((_) => sync())); // 从系统设置授权回来
    refreshPermission().then((_) => sync());
  }

  Future<bool> refreshPermission() async {
    if (!canHear) return false;
    if (_desktop) { granted = true; running = DesktopEar.instance.running; notifyListeners(); return true; } // 桌面没有运行时权限弹窗；Windows 的隐私设置在开耳朵时报告
    granted = await Hearing.hasPermission(); running = await Hearing.isRunning(); notifyListeners(); return granted;
  }

  static bool local(String base) => base.contains('127.0.0.1') || base.contains('localhost');

  /// 基座想听、本机有权限、agent 在本机 → 开；否则关。没权限时每次都重查（权限可能在设置里或经 adb 刚被授予）。
  /// 开耳朵是异步的（桌面版要起录音程序）：上一次还没做完时只记下「再来一次」，不并发。
  Future<void> sync() async {
    if (!canHear) return;
    if (_busy) { _again = true; return; }
    _busy = true;
    try { await _sync(); } finally { _busy = false; }
    if (_again) { _again = false; await sync(); }
  }

  Future<void> _sync() async {
    if (!granted) granted = hasBody ? await Hearing.hasPermission() : true;
    final h = (api.status['hearing'] as Map?) ?? {};
    final want = h['listening'] == true && api.conn == Conn.online && granted && local(api.base);
    final sensitivity = ((h['sensitivity'] ?? 2) as num).toInt();
    final key = '${api.base}|${api.token}|$sensitivity';
    try {
      if (want && (!running || key != _key)) {
        if (_desktop && key == _failedKey && DateTime.now().millisecondsSinceEpoch - _failedAt < 60000) return;
        if (hasBody) {
          await Hearing.start(base: api.base, token: api.token, fingerprint: api.current?.fp ?? '', sensitivity: sensitivity);
        } else {
          await DesktopEar.instance.start(base: api.base, token: api.token, sensitivity: sensitivity);
        }
        _key = key; running = true; error = null; _failedKey = '';
        api.call('player.set', {'enabled': true}).catchError((_) => null); // 耳朵开着：登记为她的播放器
      } else if (!want && running) {
        if (hasBody) { await Hearing.stop(); } else { await DesktopEar.instance.stopPlayback(); await DesktopEar.instance.stop(); }
        running = false;
        api.call('player.set', {'enabled': false}).catchError((_) => null);
      } else if (running && api.conn == Conn.online && !_registered) {
        api.call('player.set', {'enabled': true}).catchError((_) => null); // 重连后重新登记
      }
      _registered = running && api.conn == Conn.online;
    } catch (e) {
      error = '$e';
      if (_desktop) { _failedKey = key; _failedAt = DateTime.now().millisecondsSinceEpoch; running = false; }
    }
    notifyListeners();
  }

  void _onEvent(Map<String, dynamic> e) {
    switch (e['kind']) {
      case 'state': running = e['running'] == true; if (!running) speaking = false;
      case 'speech':
        if (DateTime.now().millisecondsSinceEpoch < speakingUntil) return; // 她在说话：耳朵里的动静多半是她自己；是不是插嘴由基座比对后用 hearing 事件告知
        speaking = e['on'] == true;
        _speakTimer?.cancel();
        if (!speaking) {
          speaking = true; _speakTimer = Timer(const Duration(milliseconds: 1200), () { speaking = false; notifyListeners(); }); // 说完后再亮一会儿
          pending = true; _pendingTimer?.cancel(); _pendingTimer = Timer(const Duration(seconds: 20), () { pending = false; notifyListeners(); }); // 每句都交给基座识别，等它的 heard 事件
        }
      case 'heard': lastHeard = e; error = null; pending = false; _pendingTimer?.cancel();
      case 'playing': playing = e['on'] == true;
      case 'played': api.call('player.done', {'id': e['id'], 'interrupted': e['interrupted'] == true, if (e['utterance'] != null) 'utterance': e['utterance']}).catchError((_) => null);
      case 'error': error = '${e['message']}';
    }
    notifyListeners();
  }
}

final hearing = HearingController();
