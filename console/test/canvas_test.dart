// Canvas 面板（#33 / #34）：显示与预览 / 编辑切换、保存成新版本（带基于的版本）、她改了时实时刷新与编辑中的提示、
//   选中一段加评论（发给她）、评论的状态、运行结果、她的新动作的角标、代码高亮。数据来源换成内存里的假运行基座。
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/code_highlight.dart';
import 'package:quetzal_console/pages/canvas.dart';

/// 内存里的假运行基座：只实现面板用到的 canvas.* 方法，记下每次调用。
class FakeCanvas implements CanvasBackend {
  final docs = <String, Map<String, dynamic>>{};
  final calls = <(String, Map<String, dynamic>)>[];
  final ctl = StreamController<Map>.broadcast();
  @override
  Stream<Map> get changes => ctl.stream;

  Map<String, dynamic> add(String id, {String title = '方案', String kind = 'markdown', String lang = '', String content = '', List<Map> threads = const []}) =>
      docs[id] = {'id': id, 'conv': 'c1', 'title': title, 'kind': kind, 'lang': lang, 'content': content, 'version': 1, 'versionId': 'v-$id-1', 'versions': 1, 'threads': [...threads], 'runs': <Map>[], 'open': 0};

  void bump(String id, String content) {
    final d = docs[id]!;
    d['content'] = content; d['version'] = (d['version'] as int) + 1; d['versionId'] = 'v-$id-${d['version']}';
  }

  @override
  Future<T> call<T>(String method, [Map<String, dynamic>? params]) async {
    final p = params ?? <String, dynamic>{};
    calls.add((method, p));
    final d = docs['${p['id']}'];
    Object? r;
    switch (method) {
      case 'canvas.list': r = docs.values.where((x) => x['conv'] == p['conv']).map((x) => {...x}..remove('content')).toList();
      case 'canvas.get': r = {...d!};
      case 'canvas.edit':
        final conflict = p['base'] != d!['versionId'];
        bump('${p['id']}', '${p['content']}');
        r = {'canvas': {...d}, 'conflict': conflict, 'changed': true};
      case 'canvas.comment':
        final s = p['start'] as int?, e = p['end'] as int?;
        final t = {'id': 'cm-1', 'author': 'user', 'ts': 0, 'text': p['text'], 'quote': s == null ? '' : '${d!['content']}'.substring(s, e), 'at': {'start': s ?? 0, 'end': e ?? 0, 'status': 'exact'}, 'resolved': false, 'replies': <Map>[], 'suggestion': null};
        (d!['threads'] as List).add(t);
        r = t;
      case 'canvas.run':
        final run = {'id': 'run-1', 'code': 0, 'out': 'hello from python\n', 'err': '', 'ms': 120, 'by': 'user', 'images': <Map>[]};
        (d!['runs'] as List).insert(0, run);
        r = run;
      case 'canvas.resolve': r = {'id': p['thread'], 'resolved': p['resolved']};
      default: r = null;
    }
    return r as T;
  }
}

Future<void> pumpPanel(WidgetTester t, FakeCanvas be) async {
  await t.pumpWidget(MaterialApp(home: Scaffold(body: SizedBox(width: 900, height: 700, child: CanvasPanel(conv: 'c1', backend: be)))));
  await t.pumpAndSettle();
}

void main() {
  setUp(() { CanvasNotices.reset(); });

  testWidgets('没有 canvas 时说明并可以新建', (t) async {
    final be = FakeCanvas();
    canvasBackend = be;
    await pumpPanel(t, be);
    expect(find.text('这个会话还没有 canvas'), findsOneWidget);
    expect(find.text('新建 canvas'), findsOneWidget);
  });

  testWidgets('文档：预览渲染 Markdown，切到编辑后改动 → 保存为新版本（带基于的版本）', (t) async {
    final be = FakeCanvas()..add('cv-a', content: '# 计划\n\n第一步');
    canvasBackend = be;
    await pumpPanel(t, be);
    expect(find.text('计划'), findsOneWidget, reason: '标题按 Markdown 渲染');
    expect(find.text('第 1 版'), findsOneWidget);
    expect(find.byKey(const ValueKey('canvas-editor')), findsNothing);
    await t.tap(find.byTooltip('编辑'));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const ValueKey('canvas-editor')), '# 计划\n\n第一步\n第二步');
    await t.pump();
    expect(find.text('第 1 版 · 未保存'), findsOneWidget);
    await t.tap(find.byTooltip('保存'));
    await t.pumpAndSettle();
    final edit = be.calls.lastWhere((c) => c.$1 == 'canvas.edit').$2;
    expect(edit['content'], '# 计划\n\n第一步\n第二步');
    expect(edit['base'], 'v-cv-a-1');
    expect(find.text('第 2 版'), findsOneWidget);
  });

  testWidgets('她改了：没在编辑时立即刷新；有没保存的改动时提示，可以载入她的版本', (t) async {
    final be = FakeCanvas()..add('cv-b', kind: 'code', lang: 'python', content: 'print(1)');
    canvasBackend = be;
    await pumpPanel(t, be);
    be.bump('cv-b', 'print(2)');
    be.ctl.add({'doc': 'cv-b', 'conv': 'c1', 'kind': 'edited', 'author': 'agent'});
    await t.pumpAndSettle();
    expect(find.text('print(2)'), findsOneWidget);
    await t.enterText(find.byKey(const ValueKey('canvas-editor')), 'print(2)  # 我的');
    await t.pump();
    be.bump('cv-b', 'print(3)');
    be.ctl.add({'doc': 'cv-b', 'conv': 'c1', 'kind': 'edited', 'author': 'agent'});
    await t.pumpAndSettle();
    expect(find.textContaining('改过这份 canvas'), findsOneWidget);
    expect(find.text('print(2)  # 我的'), findsOneWidget, reason: '不覆盖正在编辑的内容');
    await t.tap(find.text('载入她的版本'));
    await t.pumpAndSettle();
    expect(find.text('print(3)'), findsOneWidget);
  });

  testWidgets('选中一段加评论：带上位置发给她，评论列表显示被评论的原文；运行显示结果', (t) async {
    final be = FakeCanvas()..add('cv-c', kind: 'code', lang: 'python', content: 'x = 1\nprint(x)\n');
    canvasBackend = be;
    await pumpPanel(t, be);
    final field = t.widget<TextField>(find.byKey(const ValueKey('canvas-editor')));
    field.controller!.selection = const TextSelection(baseOffset: 6, extentOffset: 14);
    await t.pump();
    await t.tap(find.byTooltip('评论选中内容'));
    await t.pumpAndSettle();
    expect(find.text('评论选中的内容'), findsOneWidget);
    await t.enterText(find.byKey(const ValueKey('comment-text')), '这里打印得更清楚些');
    await t.tap(find.widgetWithText(FilledButton, '评论'));
    await t.pumpAndSettle();
    final c = be.calls.lastWhere((c) => c.$1 == 'canvas.comment').$2;
    expect([c['start'], c['end'], c['send'], c['text']], [6, 14, true, '这里打印得更清楚些']);
    expect(find.byKey(const ValueKey('thread-cm-1')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const ValueKey('thread-cm-1')), matching: find.text('print(x)')), findsOneWidget);

    await t.tap(find.byTooltip('运行'));
    await t.pumpAndSettle();
    expect(find.textContaining('退出码 0'), findsOneWidget);
    expect(find.text('hello from python\n'), findsOneWidget);
  });

  testWidgets('评论的状态：过时、已重新定位、编辑建议可以采纳', (t) async {
    final be = FakeCanvas()..add('cv-d', content: '正文', threads: [
      {'id': 'cm-s', 'author': 'agent', 'ts': 0, 'text': '旧的意见', 'quote': '没了的话', 'at': {'start': 0, 'end': 0, 'status': 'stale'}, 'resolved': false, 'replies': <Map>[], 'suggestion': null},
      {'id': 'cm-m', 'author': 'agent', 'ts': 0, 'text': '换个词', 'quote': '正文', 'at': {'start': 0, 'end': 2, 'status': 'moved'}, 'resolved': false, 'replies': [{'author': 'user', 'text': '好'}], 'suggestion': '内容'},
    ]);
    canvasBackend = be;
    await pumpPanel(t, be);
    await t.tap(find.byTooltip('评论'));
    await t.pumpAndSettle();
    expect(find.text('过时'), findsOneWidget);
    expect(find.text('已重新定位'), findsOneWidget);
    expect(find.text('建议改为'), findsOneWidget);
    expect(find.text('采纳'), findsOneWidget);
    await t.tap(find.descendant(of: find.byKey(const ValueKey('thread-cm-s')), matching: find.text('解决')));
    await t.pumpAndSettle();
    expect(be.calls.any((c) => c.$1 == 'canvas.resolve' && c.$2['thread'] == 'cm-s' && c.$2['resolved'] == true), isTrue);
  });

  testWidgets('她新建、修改或评论时 Canvas 按钮带角标，打开后清零', (t) async {
    final be = FakeCanvas()..add('cv-e', content: 'a');
    canvasBackend = be;
    await t.pumpWidget(const MaterialApp(home: Scaffold(body: CanvasButton(conv: 'c1'))));
    be.ctl.add({'doc': 'cv-e', 'conv': 'c1', 'kind': 'comment', 'author': 'agent'});
    be.ctl.add({'doc': 'cv-e', 'conv': 'c1', 'kind': 'edited', 'author': 'user'}); // 自己的不算
    be.ctl.add({'doc': 'cv-x', 'conv': 'c2', 'kind': 'edited', 'author': 'agent'}); // 别的会话
    await t.pump();
    expect(find.text('1'), findsOneWidget);
    await t.tap(find.byTooltip('Canvas'));
    await t.pumpAndSettle();
    expect(find.text('Canvas'), findsOneWidget, reason: '手机上推入全屏页');
    expect(CanvasNotices.instance.of('c1'), 0);
  });

  test('代码高亮：片段拼起来与原文一致，关键字、字符串、注释分别着色', () {
    const code = 'def f(x):\n    return "hi" # 注释\n';
    const p = CodePalette(comment: Color(0xFF000001), string: Color(0xFF000002), number: Color(0xFF000003), keyword: Color(0xFF000004));
    final spans = highlight(code, 'python', p);
    expect(spans.map((s) => s.text).join(), code);
    Color? colorOf(String s) => spans.firstWhere((x) => x.text == s).style?.color;
    expect(colorOf('def'), p.keyword);
    expect(colorOf('"hi"'), p.string);
    expect(colorOf('# 注释'), p.comment);
    expect(highlight('x' * 70000, 'python', p).length, 1, reason: '太长不着色');
    expect(canvasExt({'kind': 'code', 'lang': 'python'}), 'py');
    expect(canvasExt({'kind': 'markdown', 'lang': ''}), 'md');
  });
}
