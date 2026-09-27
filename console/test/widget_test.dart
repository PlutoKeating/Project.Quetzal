import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:amani_console/widgets.dart';

void main() {
  testWidgets('驱动力条显示百分比', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: DriveBar('好奇', 0.42))));
    expect(find.text('好奇'), findsOneWidget);
    expect(find.text('42%'), findsOneWidget);
  });

  testWidgets('光团可以渲染各种状态', (tester) async {
    for (final m in ['asleep', 'awake', 'active', 'stopped']) {
      await tester.pumpWidget(MaterialApp(home: Orb(mode: m, alertness: 0.5)));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(Orb), findsOneWidget);
    }
  });
}
