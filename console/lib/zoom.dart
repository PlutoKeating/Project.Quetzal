// 界面字号（原生桌面版）：按比例缩放全部文字（MaterialApp 外层 MediaQuery 的 textScaler），记在本机（shared_preferences 的 ui.scale）。
//   Ctrl + = / Ctrl + +（含小键盘）放大，Ctrl + -（含小键盘）缩小，Ctrl + 0 还原；在任何页面、输入框有没有焦点都生效。
//   设置页在「控制 · 高级 · 字号」。安卓跟随系统字号，网页版用浏览器自己的缩放，都不启用。
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

const zoomMin = 0.8, zoomMax = 1.6, zoomStep = 0.1;

/// 一个按键对应的缩放动作：1 放大、-1 缩小、0 还原；不是缩放键为 null（不判断 Ctrl）。
int? zoomAction(LogicalKeyboardKey k) {
  if (k == LogicalKeyboardKey.equal || k == LogicalKeyboardKey.add || k == LogicalKeyboardKey.numpadAdd) return 1;
  if (k == LogicalKeyboardKey.minus || k == LogicalKeyboardKey.numpadSubtract) return -1;
  if (k == LogicalKeyboardKey.digit0 || k == LogicalKeyboardKey.numpad0) return 0;
  return null;
}

/// 夹在 [zoomMin, zoomMax] 之内，取到 0.1 的整数倍（避免 1.2000000000000002 这样的累积误差）。
double clampZoom(double v) => (v.clamp(zoomMin, zoomMax) * 10).round() / 10;

class Zoom extends ChangeNotifier {
  static const key = 'ui.scale';
  double scale = 1;
  bool _started = false;

  /// 读出记下的字号并挂上快捷键（只调用一次）。
  Future<void> start() async {
    if (_started) return;
    _started = true;
    HardwareKeyboard.instance.addHandler(handleKey);
    try {
      final v = (await SharedPreferences.getInstance()).getDouble(key);
      if (v != null) set(v, save: false);
    } catch (_) {}
  }

  void set(double v, {bool save = true}) {
    v = clampZoom(v);
    if (v == scale) return;
    scale = v;
    notifyListeners();
    if (save) SharedPreferences.getInstance().then((p) => p.setDouble(key, v)).catchError((_) => false);
  }

  /// Ctrl + = / - / 0：是缩放键就返回 true（输入框对这几个组合键本来就没有动作）。
  bool handleKey(KeyEvent e) {
    if (e is KeyUpEvent) return false;
    final kb = HardwareKeyboard.instance;
    if (!(kb.isControlPressed || kb.isMetaPressed) || kb.isAltPressed) return false;
    final a = zoomAction(e.logicalKey);
    if (a == null) return false;
    set(a == 0 ? 1 : scale + a * zoomStep);
    return true;
  }
}

final zoom = Zoom();
