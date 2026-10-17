// 「操作屏幕」卡片：按无障碍服务的状态说明用途、带去系统设置；安卓 13+ 没开时提示「允许受限设置」。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/control.dart';

void main() {
  const ch = MethodChannel('quetzal/runtime');

  Future<List<String>> pump(WidgetTester tester, Map<String, bool> status) async {
    final calls = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(ch, (call) async {
      calls.add(call.method);
      return call.method == 'handsStatus' ? status : null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(ch, null));
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: HandsSetupCard())));
    await tester.pumpAndSettle();
    return calls;
  }

  testWidgets('没开：说明用途，「去开启」直达系统设置；安卓 13+ 另有「应用信息」', (tester) async {
    final calls = await pump(tester, {'enabled': false, 'connected': false, 'screenshot': true, 'restricted': true});
    expect(find.textContaining('让 ta 替你操作手机'), findsOneWidget);
    expect(find.textContaining('允许受限设置'), findsOneWidget);
    await tester.tap(find.text('去开启'));
    await tester.tap(find.text('应用信息'));
    await tester.pump();
    expect(calls, containsAll(['handsStatus', 'openHandsSettings', 'openAppDetails']));
  });

  testWidgets('开了但没连上：请关掉再打开', (tester) async {
    await pump(tester, {'enabled': true, 'connected': false, 'screenshot': true, 'restricted': false});
    expect(find.textContaining('还没有连上'), findsOneWidget);
    expect(find.text('应用信息'), findsNothing);
  });

  testWidgets('已开启：说明每次仍按权限档位把关（缺省交给审核模型）；安卓 11 以下说明不能截图', (tester) async {
    await pump(tester, {'enabled': true, 'connected': true, 'screenshot': false, 'restricted': true});
    expect(find.textContaining('已开启'), findsOneWidget);
    expect(find.textContaining('不能截图'), findsOneWidget);
    expect(find.textContaining('缺省交给审核模型判断'), findsOneWidget);
    expect(find.textContaining('允许受限设置'), findsNothing);
    expect(find.text('系统设置'), findsOneWidget);
  });
}
