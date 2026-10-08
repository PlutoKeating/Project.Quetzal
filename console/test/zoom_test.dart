// 原生桌面版的界面字号：快捷键、范围与本机记忆。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/zoom.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('缩放键：= 与 + 放大，- 缩小，0 还原（含小键盘）', () {
    for (final k in [LogicalKeyboardKey.equal, LogicalKeyboardKey.add, LogicalKeyboardKey.numpadAdd]) { expect(zoomAction(k), 1); }
    for (final k in [LogicalKeyboardKey.minus, LogicalKeyboardKey.numpadSubtract]) { expect(zoomAction(k), -1); }
    for (final k in [LogicalKeyboardKey.digit0, LogicalKeyboardKey.numpad0]) { expect(zoomAction(k), 0); }
    expect(zoomAction(LogicalKeyboardKey.keyA), isNull);
  });

  test('范围 80%–160%，取到 10% 的整数倍', () {
    expect(clampZoom(0.5), zoomMin);
    expect(clampZoom(3), zoomMax);
    expect(clampZoom(1.1 + 0.1), 1.2);
  });

  testWidgets('Ctrl + = / - / 0 改字号并记在本机；不按 Ctrl 不处理', (tester) async {
    SharedPreferences.setMockInitialValues({Zoom.key: 1.3});
    final z = Zoom();
    await z.start();
    expect(z.scale, 1.3, reason: '读出上次记下的字号');
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: TextField(autofocus: true))));

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.equal);
    expect(z.scale, 1.4);
    await tester.sendKeyEvent(LogicalKeyboardKey.minus);
    await tester.sendKeyEvent(LogicalKeyboardKey.minus);
    expect(z.scale, 1.2);
    await tester.sendKeyEvent(LogicalKeyboardKey.digit0);
    expect(z.scale, 1);
    for (var i = 0; i < 20; i++) { await tester.sendKeyEvent(LogicalKeyboardKey.equal); }
    expect(z.scale, zoomMax);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);

    await tester.sendKeyEvent(LogicalKeyboardKey.digit0);
    expect(z.scale, zoomMax, reason: '没按 Ctrl：是输入框的 0');
    await tester.pump();
    expect((await SharedPreferences.getInstance()).getDouble(Zoom.key), zoomMax);
    HardwareKeyboard.instance.removeHandler(z.handleKey);
  });
}
