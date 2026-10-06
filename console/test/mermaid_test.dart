// Linux 桌面版的 Mermaid 图：原生侧（看不见的 WebKitGTK）截图成 PNG 交回来显示；没有 WebKitGTK 时交给运行基座画，再不行显示源码。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/platform/mermaid_common.dart';
import 'package:quetzal_console/platform/mermaid_linux.dart';

// 1×1 的透明 PNG
final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');

void main() {
  const ch = MethodChannel('quetzal/mermaid');
  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, null));

  Widget host(Widget w) => MaterialApp(theme: ThemeData(brightness: Brightness.dark), home: Scaffold(body: w));

  testWidgets('渲染成功：显示原生侧截好的 PNG，按 scale 换算成逻辑尺寸；同一张图只渲染一次', (t) async {
    final calls = <Map>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (c) async {
      calls.add(c.arguments as Map);
      return {'png': png, 'scale': 2.0};
    });
    await t.pumpWidget(host(const SnapshotMermaid('flowchart TB\n A --> B')));
    await t.pumpAndSettle();
    expect(find.byType(Image), findsOneWidget);
    expect(calls.single['code'], 'flowchart TB\n A --> B');
    expect(calls.single['dark'], isTrue);
    expect((t.widget(find.byType(Image)) as Image).image, isA<MemoryImage>().having((m) => m.scale, 'scale', 2.0));
    await t.pumpWidget(host(const SnapshotMermaid('flowchart TB\n A --> B')));
    await t.pumpAndSettle();
    expect(calls, hasLength(1), reason: '缓存');
  });

  testWidgets('mermaid 报错：显示原因与源码', (t) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (c) async {
      throw PlatformException(code: 'render', message: jsonEncode({'error': 'Parse error on line 2', 'id': '1'}));
    });
    await t.pumpWidget(host(const SnapshotMermaid('flowchart TB\n A --> ((')));
    await t.pumpAndSettle();
    expect(find.byType(MermaidFailed), findsOneWidget);
    expect(find.text('图表无法渲染：Parse error on line 2'), findsOneWidget);
    expect(find.text('flowchart TB\n A --> (('), findsOneWidget);
  });

  testWidgets('没有 WebKitGTK：交给运行基座画（未连接时显示源码）', (t) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(ch, (c) async {
      throw PlatformException(code: 'unavailable', message: '这台电脑上没有 WebKitGTK');
    });
    await t.pumpWidget(host(const SnapshotMermaid('graph LR\n X --> Y')));
    await t.pumpAndSettle();
    expect(find.text('图表无法渲染：未连接'), findsOneWidget);
    expect(find.text('graph LR\n X --> Y'), findsOneWidget);
  });

  test('缓存有上限：最近用过的留下', () {
    final m = <int, int>{};
    for (var i = 0; i < 5; i++) { putBounded(m, i, i, max: 3); }
    putBounded(m, 2, 2, max: 3);
    putBounded(m, 9, 9, max: 3);
    expect(m.keys, [4, 2, 9]);
  });
}
