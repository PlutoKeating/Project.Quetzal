// 首页的目标视图（#23）：她进行中的长期目标（标题、进度、步骤），点开看每一步，可以替她标为完成或放下（goals.close）；没有目标就不占位。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/pages/home.dart';

Widget _wrap(Widget w) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: w)));

final _goal = {
  'id': 'a1b2c3d4', 'title': '帮对方办好签证', 'detail': '下个月出发', 'status': 'open',
  'steps': [
    {'id': '1', 'text': '查材料清单', 'status': 'done'},
    {'id': '2', 'text': '预约', 'status': 'doing'},
    {'id': '3', 'text': '递交', 'status': 'todo'},
  ],
  'progress': {'done': 1, 'total': 3, 'ratio': 1 / 3},
};

void main() {
  tearDown(() => api.status = {});

  testWidgets('没有目标时不占位', (t) async {
    api.status = {'goals': []};
    await t.pumpWidget(_wrap(const GoalsSection()));
    expect(find.text('目标'), findsNothing);
  });

  testWidgets('列出目标与进度；没有步骤的写明；点开看每一步，标为完成时先确认再调用关闭', (t) async {
    api.status = {'goals': [_goal, {'id': 'e5f6a7b8', 'title': '学会做咖喱', 'steps': [], 'status': 'open', 'progress': null}]};
    final closed = <String>[];
    await t.pumpWidget(_wrap(GoalsSection(onClose: (id, outcome) async => closed.add('$id:$outcome'))));
    expect(find.text('目标'), findsOneWidget);
    expect(find.text('帮对方办好签证'), findsOneWidget);
    expect(find.text('1 / 3 步'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    expect(find.text('没有分步骤'), findsOneWidget);

    await t.tap(find.text('帮对方办好签证'));
    await t.pumpAndSettle();
    expect(find.text('查材料清单'), findsOneWidget);
    expect(find.text('预约'), findsOneWidget);
    expect(find.text('进行中'), findsOneWidget);
    expect(find.byIcon(Icons.check_circle), findsOneWidget);
    await t.tap(find.text('标为完成'));
    await t.pumpAndSettle();
    expect(find.text('帮对方办好签证'), findsWidgets); // 确认框里写着是哪个目标
    expect(closed, isEmpty, reason: '确认之前不关闭');
    await t.tap(find.text('确定'));
    await t.pumpAndSettle();
    expect(closed, ['a1b2c3d4:done']);
    expect(find.text('查材料清单'), findsNothing, reason: '关闭后详情收起');
  });

  testWidgets('放下：outcome 为 dropped', (t) async {
    api.status = {'goals': [_goal]};
    final closed = <String>[];
    await t.pumpWidget(_wrap(GoalsSection(onClose: (id, outcome) async => closed.add('$id:$outcome'))));
    await t.tap(find.text('帮对方办好签证'));
    await t.pumpAndSettle();
    await t.tap(find.text('放下'));
    await t.pumpAndSettle();
    await t.tap(find.text('确定'));
    await t.pumpAndSettle();
    expect(closed, ['a1b2c3d4:dropped']);
  });
}
