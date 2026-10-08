// 启动、更新后重启时：首页与右栏的部件在父级里是 const，要自己跟着状态刷新；页面在连上的那一刻重新加载。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/pages/home.dart';
import 'package:quetzal_console/widgets.dart';

class _Probe extends StatefulWidget {
  const _Probe();
  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> with ReloadOnConnect {
  int loads = 0;
  @override
  void reloadOnConnect() => setState(() => loads++);
  @override
  Widget build(BuildContext context) => Text('loads $loads');
}

void main() {
  tearDown(() { api.status = {}; api.conn = Conn.unpaired; });

  testWidgets('const 的「内在」在状态到达后自己刷新，不停在启动瞬间的 0%', (t) async {
    api.status = {};
    await t.pumpWidget(const MaterialApp(home: Scaffold(body: SingleChildScrollView(child: InnerSection()))));
    expect(find.text('50%'), findsNothing);
    api.status = {'heart': {'drives': {'curiosity': 0.5}, 'alertness': 0.2, 'S': 0.1}};
    // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    api.notifyListeners();
    await t.pump();
    expect(find.text('50%'), findsOneWidget);
  });

  testWidgets('页面创建时还没连上：连上的那一刻重新加载；之后同一次连接里不重复', (t) async {
    api.conn = Conn.connecting;
    await t.pumpWidget(const MaterialApp(home: _Probe()));
    expect(find.text('loads 0'), findsOneWidget);
    api.conn = Conn.online;
    // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    api.notifyListeners();
    await t.pump();
    expect(find.text('loads 1'), findsOneWidget);
    // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    api.notifyListeners();
    await t.pump();
    expect(find.text('loads 1'), findsOneWidget);
  });
}
