// 她的回复下面的「复制」与「导出为 Markdown」（#22）。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/chat.dart';

void main() {
  testWidgets('点「复制」把整条回复原文（Markdown）放进剪贴板', (t) async {
    String? copied;
    t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String;
      return null;
    });
    const text = '## 结论\n\n- 第一点\n- `代码`';
    await t.pumpWidget(const MaterialApp(home: Scaffold(body: ReplyActions(text, ts: 0))));
    await t.tap(find.byTooltip('复制'));
    await t.pump();
    expect(copied, text);
    expect(find.text('已复制这条回复'), findsOneWidget);
    expect(find.byTooltip('导出为 Markdown'), findsOneWidget);
  });

  test('导出的文件名取这条回复的当地时刻', () {
    final ts = DateTime(2026, 10, 17, 9, 5, 3).millisecondsSinceEpoch;
    expect(ReplyActions.fileName(ts), 'quetzal-20261017-090503.md');
  });
}
