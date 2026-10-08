// 对话输入框的粘贴：剪贴板里的文件或图片进附件，文字照常粘贴；粘贴图片的名字。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/chat.dart';

void main() {
  Future<TextEditingController> field(WidgetTester tester, Future<bool> Function() attach) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.getData') return {'text': '剪贴板里的字'};
      if (call.method == 'Clipboard.hasStrings') return {'value': true};
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
    final c = TextEditingController();
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Actions(actions: {PasteTextIntent: PasteAttachAction(attach)}, child: TextField(controller: c, autofocus: true)))));
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    return c;
  }

  testWidgets('剪贴板里没有文件和图片：照常粘贴文字', (tester) async {
    var asked = 0;
    final c = await field(tester, () async { asked++; return false; });
    expect(asked, 1);
    expect(c.text, '剪贴板里的字');
  }, variant: const TargetPlatformVariant({TargetPlatform.linux, TargetPlatform.windows}));

  testWidgets('加入了附件：不再粘贴文字', (tester) async {
    final c = await field(tester, () async => true);
    expect(c.text, isEmpty);
  }, variant: const TargetPlatformVariant({TargetPlatform.linux, TargetPlatform.windows}));

  test('粘贴的图片按时刻起名，扩展名跟着类型', () {
    expect(pastedName(), matches(RegExp(r'^pasted-\d{8}-\d{6}\.png$')));
    expect(pastedName('image/jpeg'), endsWith('.jpg'));
    expect(pastedName('image/gif'), endsWith('.gif'));
    expect(pastedName('image/svg+xml'), endsWith('.png'), reason: '不像扩展名的类型退回 png');
  });
}
