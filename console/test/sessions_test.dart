// 会话列表增强（#30）：置顶、搜索（片段高亮、点开定位到那条消息）、筛选与排序、按项目分组、移到项目、项目的新建；旧版基座没有项目接口时不显示项目入口。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/api.dart';
import 'package:quetzal_console/pages/chat.dart';
import 'package:quetzal_console/pages/projects.dart';
import 'package:quetzal_console/pages/sessions.dart';

final now = DateTime(2026, 10, 17, 12).millisecondsSinceEpoch;
Map sess(String id, String title, {int pinned = 0, String? project}) => {'id': id, 'title': title, 'channel': '控制台', 'created': now, 'updated': now, 'archived': false, 'count': 2, 'last': '最后一句', 'pinned': pinned, 'project': project};
final work = {'id': '0123456789abcdef', 'name': '工作', 'description': '', 'instructions': '正式一点', 'color': '#5b8fd6', 'icon': 'work', 'created': now, 'updated': now};

/// 模拟的运行基座：记下每次调用，按方法回答。
class FakeRuntime {
  final calls = <(String, Map<String, dynamic>)>[];
  bool projects = true;
  List<Map> list = [sess('a', '置顶的会话', pinned: now), sess('b', '周报', project: work['id'] as String), sess('c', '随便聊聊')];
  Future<dynamic> call(String m, Map<String, dynamic> p) async {
    calls.add((m, p));
    switch (m) {
      case 'sessions': return p['channel'] == '飞书' ? <Map>[] : list;
      case 'sessions.live': return <Map>[];
      case 'projects': if (!projects) throw RpcError('ERR', '未知操作：projects'); return [work];
      case 'sessions.search': return [
        {'session': sess('c', '随便聊聊'), 'title': false, 'titleMarks': [], 'matches': 2, 'hit': {'message': 42, 'ts': now, 'role': 'user', 'snippet': '我们去看樱花吧', 'marks': [[4, 6]]}},
      ];
      case 'sessions.pin': case 'sessions.move': return list.first;
      case 'sessions.create': return sess('new', '新的对话', project: p['project'] as String?);
      case 'projects.create': return {...work, 'id': 'ffffffffffffffff', 'name': p['name']};
    }
    return null;
  }
  List<Map<String, dynamic>> of(String m) => calls.where((c) => c.$1 == m).map((c) => c.$2).toList();
}

late FakeRuntime rt;
Map? opened;

Future<void> pump(WidgetTester t) async {
  opened = null;
  await t.pumpWidget(MaterialApp(home: Scaffold(body: SessionsList(onOpen: (s) => opened = s))));
  await t.pumpAndSettle();
}

void main() {
  setUp(() { rt = FakeRuntime(); api.fake = rt.call; projectStore.setForTest([]); chatFocus.value = null; });
  tearDown(() => api.fake = null);

  test('高亮：按位置拆开，越界的位置收紧', () {
    final s = highlightSpans('我们去看樱花吧', [[4, 6], [100, 200]], const TextStyle(fontWeight: FontWeight.bold));
    expect(s.map((x) => x.text).toList(), ['我们去看', '樱花', '吧']);
    expect(s[1].style?.fontWeight, FontWeight.bold);
  });

  test('筛选条件：只带设了的项；时间范围从当天零点往前算', () {
    final f = SessionFilter();
    expect(f.params(false), {'archived': false, 'sort': 'updated'});
    f..channel = '飞书'..live = true..range = 'week'..project = 'none'..sort = 'title';
    final p = f.params(true, now: DateTime(2026, 10, 17, 15));
    expect(p['channel'], '飞书');
    expect(p['live'], true);
    expect(p['project'], 'none');
    expect(p['from'], DateTime(2026, 10, 11).millisecondsSinceEpoch);
    expect(f.active, isTrue);
    f.clear();
    expect(f.active, isFalse);
  });

  testWidgets('置顶图标与操作：菜单里点「置顶」调用 sessions.pin', (t) async {
    await pump(t);
    expect(find.byIcon(Icons.push_pin), findsOneWidget, reason: '置顶的会话带图标');
    await t.tap(find.descendant(of: find.byKey(const ValueKey('session-c')), matching: find.byType(PopupMenuButton<String>)));
    await t.pumpAndSettle();
    await t.tap(find.text('置顶').last);
    await t.pumpAndSettle();
    expect(rt.of('sessions.pin').single, {'id': 'c', 'pinned': true});
  });

  testWidgets('搜索：标出命中的片段，点开定位到那条消息', (t) async {
    await pump(t);
    await t.enterText(find.byKey(const ValueKey('session-search')), '樱花');
    await t.pump(const Duration(milliseconds: 300));
    await t.pumpAndSettle();
    expect(rt.of('sessions.search').last['query'], '樱花');
    expect(find.textContaining('我们去看樱花吧', findRichText: true), findsOneWidget);
    expect(find.textContaining('2 处匹配'), findsOneWidget);
    await t.tap(find.byKey(const ValueKey('hit-c')));
    expect(opened?['id'], 'c');
    expect(chatFocus.value, (conv: 'c', msg: 42));
  });

  testWidgets('按项目分组：置顶一组在前，项目一组，其余在「未归入项目」', (t) async {
    await pump(t);
    await t.tap(find.byTooltip('按项目分组'));
    await t.pumpAndSettle();
    expect(find.text('置顶  1'), findsOneWidget);
    expect(find.text('工作  1'), findsOneWidget);
    expect(find.text('未归入项目  1'), findsOneWidget);
    // 只看这个项目：带上 project 参数重新取
    await t.tap(find.byTooltip('只看这个项目'));
    await t.pumpAndSettle();
    expect(rt.of('sessions').last['project'], work['id']);
    expect(find.textContaining('筛选：项目「工作」'), findsOneWidget);
    // 正在看一个项目时新建的会话放进这个项目
    await t.tap(find.byTooltip('新会话'));
    await t.pumpAndSettle();
    expect(rt.of('sessions.create').single, {'project': work['id']});
    expect(opened?['id'], 'new');
  });

  testWidgets('筛选菜单：选来源「飞书」后带 channel 重新取，没有结果时提示', (t) async {
    await pump(t);
    await t.tap(find.byTooltip('筛选与排序'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(ChoiceChip, '飞书'));
    await t.pumpAndSettle();
    expect(rt.of('sessions').last['channel'], '飞书');
    await t.tap(find.widgetWithText(ChoiceChip, '标题'));
    await t.pumpAndSettle();
    expect(rt.of('sessions').last['sort'], 'title');
    Navigator.of(t.element(find.text('筛选与排序').last)).pop();
    await t.pumpAndSettle();
    expect(find.text('没有符合筛选的会话'), findsOneWidget);
  });

  testWidgets('移到项目：选择框里点项目，调用 sessions.move', (t) async {
    await pump(t);
    await t.tap(find.descendant(of: find.byKey(const ValueKey('session-c')), matching: find.byType(PopupMenuButton<String>)));
    await t.pumpAndSettle();
    await t.tap(find.text('移到项目…'));
    await t.pumpAndSettle();
    await t.tap(find.text('工作'));
    await t.pumpAndSettle();
    expect(rt.of('sessions.move').single, {'id': 'c', 'project': work['id']});
  });

  testWidgets('新建项目：名字与项目说明交给 projects.create', (t) async {
    await pump(t);
    await t.tap(find.byTooltip('管理项目'));
    await t.pumpAndSettle();
    expect(find.text('工作'), findsWidgets);
    await t.tap(find.text('新建项目'));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const ValueKey('project-name')), '学钢琴');
    await t.enterText(find.byKey(const ValueKey('project-instructions')), '每次练习后记下用了多久');
    await t.tap(find.text('保存'));
    await t.pumpAndSettle();
    final c = rt.of('projects.create').single;
    expect(c['name'], '学钢琴');
    expect(c['instructions'], '每次练习后记下用了多久');
    expect(c['color'], projectColors.first);
  });

  testWidgets('旧版基座没有项目接口：不显示分组与项目管理，置顶与搜索照常', (t) async {
    rt.projects = false;
    await pump(t);
    expect(projectStore.supported, isFalse);
    expect(find.byTooltip('按项目分组'), findsNothing);
    expect(find.byTooltip('管理项目'), findsNothing);
    expect(find.byKey(const ValueKey('session-search')), findsOneWidget);
  });
}
