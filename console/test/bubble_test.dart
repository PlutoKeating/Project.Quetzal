// 消息气泡里的文字：整个气泡一个选择区，跨段落全选、复制；链接照常点开。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/process.dart';

void main() {
  Widget app(Widget child) => MaterialApp(home: Scaffold(body: Center(child: child)));

  testWidgets('一个气泡一个选择区：Ctrl+A 全选整个气泡（跨段落、代码块），Ctrl+C 复制', (tester) async {
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied = (call.arguments as Map)['text'] as String?;
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    await tester.pumpWidget(app(const Bubble('第一段 **粗体**\n\n第二段\n\n```\nls -la\n```')));
    expect(find.byType(SelectionArea), findsOneWidget);
    expect(find.byType(SelectableText), findsNothing, reason: '段落不再各自成为选择区');

    await tester.tap(find.textContaining('第二段'));
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyA);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();
    expect(copied, allOf(contains('第一段'), contains('粗体'), contains('第二段'), contains('ls -la')));
  }, variant: const TargetPlatformVariant({TargetPlatform.linux, TargetPlatform.windows}));

  testWidgets('选择区里的链接照常点开（不合规的地址提示而不打开）', (tester) async {
    await tester.pumpWidget(app(const Bubble('看 [这里](http://example.com/x)')));
    await tester.tapOnText(find.textRange.ofSubstring('这里'));
    await tester.pump();
    expect(find.text('不打开这个链接：只允许 https 地址'), findsOneWidget);
  });
}
