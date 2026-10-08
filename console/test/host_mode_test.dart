import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/host_mode.dart';
import 'package:quetzal_console/shell/nav.dart';

Widget _wrap(Widget w) => MaterialApp(home: Scaffold(body: Column(children: [w])));

void main() {
  tearDown(() => api.status = {});

  testWidgets('对话里：不在真实环境时什么都不显示', (t) async {
    api.status = {'host': [], 'approvals': []};
    await t.pumpWidget(_wrap(const HostModeBar(conv: 'c1')));
    expect(find.textContaining('真实环境'), findsNothing);
  });

  testWidgets('对话里：她的请求显示理由与同意 / 拒绝，只在请求所在的会话', (t) async {
    api.status = {'host': [], 'approvals': [{'id': 'a1', 'action': '进入真实环境（命令不经沙箱）', 'reason': 'gh 要用主机上的登录', 'args': {'conv': 'c1'}, 'status': 'pending', 'kind': 'host'}]};
    await t.pumpWidget(_wrap(const HostModeBar(conv: 'c1')));
    expect(find.textContaining('请求进入真实环境'), findsOneWidget);
    expect(find.text('gh 要用主机上的登录'), findsOneWidget);
    expect(find.text('同意'), findsOneWidget);
    expect(find.text('拒绝'), findsOneWidget);
    await t.pumpWidget(_wrap(const HostModeBar(conv: 'c2')));
    expect(find.text('同意'), findsNothing);
  });

  testWidgets('审批要带 kind: host 才算进真实环境的请求（不看标题文字）', (t) async {
    api.status = {'host': [], 'approvals': [{'id': 'a2', 'action': '进入真实环境（命令不经沙箱）', 'reason': 'x', 'args': {'conv': 'c1'}, 'status': 'pending'}]};
    await t.pumpWidget(_wrap(const HostModeBar(conv: 'c1')));
    expect(find.text('同意'), findsNothing);
  });

  testWidgets('开启时：对话里有提示条，外壳顶部列出会话，都能退出；桌面版不重复列出正在打开的会话', (t) async {
    api.status = {'host': [{'conv': 'c1', 'title': '发版', 'by': 'agent'}], 'approvals': []};
    await t.pumpWidget(_wrap(const HostModeBar(conv: 'c1')));
    expect(find.textContaining('命令不经沙箱', findRichText: true), findsOneWidget);
    expect(find.text('退出'), findsOneWidget);
    await t.pumpWidget(_wrap(const HostModeBanner()));
    expect(find.textContaining('「发版」', findRichText: true), findsOneWidget);
    nav.go('chat', id: 'c1');
    await t.pumpWidget(_wrap(const HostModeBanner(skipOpen: true)));
    expect(find.textContaining('「发版」', findRichText: true), findsNothing);
    nav.go('chat', id: 'c9');
    await t.pumpWidget(_wrap(const HostModeBanner(skipOpen: true)));
    expect(find.textContaining('「发版」', findRichText: true), findsOneWidget);
    await t.pumpWidget(_wrap(const HostModeBar(conv: 'c2')));
    expect(find.textContaining('真实环境'), findsNothing);
  });
}
