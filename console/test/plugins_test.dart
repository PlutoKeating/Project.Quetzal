import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/plugins.dart';

Widget _wrap(Widget w) => MaterialApp(home: Scaffold(body: w));

final _sources = {
  'max': 32, 'error': '',
  'sources': [
    {'id': 'github', 'title': 'GitHub', 'transport': 'http', 'enabled': true, 'sync': true, 'state': 'online', 'tools': 12, 'resources': 0, 'prompts': 2, 'secrets': []},
    {'id': 'notion', 'title': 'Notion', 'transport': 'http', 'enabled': true, 'sync': true, 'state': 'auth', 'error': '需要登录', 'tools': 0, 'resources': 0, 'prompts': 0, 'secrets': []},
    {'id': 'files', 'title': '文件系统', 'transport': 'stdio', 'enabled': false, 'sync': false, 'state': 'off', 'tools': 0, 'resources': 0, 'prompts': 0, 'secrets': ['mcp_files_token']},
  ],
};
final _overview = {
  'recommendations': [{'id': 'playwright', 'name': 'Playwright 浏览器', 'reason': '你说要帮你填报名表', 'conv': 'c1', 'ts': 1}],
  'installed': [{'name': 'demo-kit', 'version': '1.2.0', 'description': '演示', 'source': '/tmp/demo', 'mcp': ['local'], 'skills': ['note-taking'], 'commands': [{'name': 'hello'}], 'agents': []}],
  'catalog': [
    {'id': 'playwright', 'name': 'Playwright 浏览器', 'description': '网页表单', 'category': 'browser', 'license': 'Apache-2.0', 'source': 'https://github.com/microsoft/playwright-mcp', 'maintainer': '微软（官方）', 'transport': 'stdio', 'installed': false},
    {'id': 'github', 'name': 'GitHub', 'description': 'issue 与 PR', 'category': 'dev', 'license': 'MIT', 'source': 'https://github.com/github/github-mcp-server', 'maintainer': 'GitHub（官方）', 'transport': 'http', 'installed': true},
  ],
  'marketplaces': [{'name': 'team-tools', 'owner': '团队', 'plugins': [{'name': 'gh-helper', 'description': 'GitHub 助手', 'installed': false}]}],
};

void main() {
  testWidgets('插件页：她的推荐在最上面，工具来源显示状态、同步方式与缺的凭据，推荐目录与插件目录可以安装', (t) async {
    final previews = <Map<String, dynamic>>[];
    final toggles = <String>[];
    await t.pumpWidget(_wrap(PluginsBody(sources: _sources, overview: _overview, onPreview: previews.add, onDismiss: (_) {}, onToggle: (id, v) => toggles.add('$id=$v'), onOpenSource: (_) {}, onUninstall: (_) {}, onMarket: (_, _) {})));
    expect(find.text('你说要帮你填报名表'), findsOneWidget);
    expect(find.textContaining('已连接 · 12 个工具、2 个提示词 · 多端同步'), findsOneWidget);
    expect(find.textContaining('需要登录'), findsWidgets);
    expect(find.textContaining('本机命令 · 已停用 · 仅本机'), findsOneWidget);
    expect(find.textContaining('这台设备上还缺凭据'), findsOneWidget);
    expect(find.textContaining('工具来源 local · 技能 note-taking · 1 条命令'), findsOneWidget);
    await t.tap(find.widgetWithText(FilledButton, '安装').first);
    expect(previews.last, {'catalog': 'playwright'});
    await t.tap(find.byType(Switch).last);
    expect(toggles, ['files=true']);
    await t.scrollUntilVisible(find.text('team-tools'), 200);
    await t.tap(find.text('team-tools'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(TextButton, '安装'));
    expect(previews.last, {'marketplace': 'team-tools', 'plugin': 'gh-helper'});
  });

  testWidgets('安装清单：列出来源、要填的值（凭据遮挡）、装不了的原因、技能冲突与提醒；确认时带上填的值', (t) async {
    Map? sent;
    final preview = {
      'plan': 'p1', 'name': 'demo-kit', 'version': '1.2.0', 'description': '演示', 'author': '作者', 'license': 'MIT', 'source': '/tmp/demo', 'homepage': '',
      'mcp': [
        {'key': 'remote', 'id': 'remote', 'title': 'demo-kit/remote', 'transport': 'http', 'url': 'https://mcp.example.com/mcp', 'oauth': true, 'sync': true, 'inputs': [{'key': 'DEMO_TOKEN', 'label': 'DEMO_TOKEN', 'secret': true, 'required': true}]},
        {'key': 'missing', 'id': 'missing', 'title': 'demo-kit/missing', 'transport': 'stdio', 'command': 'nope', 'args': [], 'oauth': false, 'sync': false, 'inputs': [], 'problem': '这具身体上找不到命令 nope'},
      ],
      'skills': [{'name': 'note-taking', 'description': '会议记录', 'files': ['SKILL.md'], 'skipped': ['scripts/run.sh']}, {'name': 'web-clip', 'description': '', 'files': ['SKILL.md'], 'skipped': [], 'conflict': '灵魂仓库里已有同名技能'}],
      'commands': [{'name': 'hello', 'description': '打招呼'}], 'agents': [], 'hooks': true, 'warnings': ['包里有 hooks：不执行'], 'outward': '提交前先给对方过目',
    };
    t.view.physicalSize = const Size(1200, 4000);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(_wrap(InstallSheet(preview: preview, onInstall: (inputs, enable, replace) async { sent = {'inputs': inputs, 'enable': enable, 'replace': replace}; })));
    expect(find.text('安装 demo-kit  1.2.0'), findsOneWidget);
    expect(find.textContaining('这具身体上找不到命令 nope'), findsOneWidget);
    expect(find.textContaining('程序与脚本不进灵魂仓库'), findsOneWidget);
    expect(find.textContaining('灵魂仓库里已有同名技能'), findsOneWidget);
    expect(find.text('提交前先给对方过目'), findsOneWidget);
    expect(find.text('包里有 hooks：不执行'), findsOneWidget);
    final field = t.widget<TextField>(find.byType(TextField));
    expect(field.obscureText, isTrue, reason: '凭据输入遮挡');
    await t.enterText(find.byType(TextField), 'synthetic-token');
    await t.tap(find.widgetWithText(FilledButton, '安装'));
    await t.pump();
    expect(sent, {'inputs': {'remote': {'DEMO_TOKEN': 'synthetic-token'}}, 'enable': true, 'replace': false});
  });

  test('状态说法', () {
    expect(stateLabel('auth'), '需要登录');
    expect(stateLabel('online'), '已连接');
    expect(stateLabel('denied'), '启动没被允许');
  });
}
