// 子 agent 的报告（#12）：对话里默认只显示一句「完成了」，点开才看完整报告。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/chat.dart';

void main() {
  test('拆出摘要与正文：完成的、中断的、没有正文的', () {
    expect(AgentReport.split('子 agent「调研」完成了任务（找到三篇论文）。报告：\n\n## 结论\n很长的正文'), ('子 agent「调研」完成了任务（找到三篇论文）', '## 结论\n很长的正文'));
    expect(AgentReport.split('子 agent「调研」中断了：基座重启\n\n它中断前做的事：shell（ok）'), ('子 agent「调研」中断了：基座重启', '它中断前做的事：shell（ok）'));
    expect(AgentReport.split('子 agent「调研」中断了：急停中'), ('子 agent「调研」中断了：急停中', ''));
  });

  testWidgets('默认折叠，点「查看报告」展开，再点收起', (t) async {
    await t.pumpWidget(const MaterialApp(home: Scaffold(body: AgentReport('子 agent「调研」完成了任务（找到三篇论文）。报告：\n\n正文里的第一句话'))));
    expect(find.textContaining('完成了任务（找到三篇论文）'), findsOneWidget);
    expect(find.textContaining('正文里的第一句话'), findsNothing);
    await t.tap(find.text('查看报告'));
    await t.pumpAndSettle();
    expect(find.textContaining('正文里的第一句话'), findsOneWidget);
    await t.tap(find.text('收起报告'));
    await t.pumpAndSettle();
    expect(find.textContaining('正文里的第一句话'), findsNothing);
  });
}
