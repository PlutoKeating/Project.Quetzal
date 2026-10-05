// 控制：日常调节 → 安全 → 连接与运维，越往下越偏技术。审批的理由按 Markdown 渲染；审计日志点开看完整参数与输出。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import 'providers.dart';
import 'agents.dart';
import 'setup.dart';
import 'about.dart';
import 'tools.dart';
import 'hearing.dart';
import 'mesh.dart';
import 'account.dart';
import '../installer.dart';
import '../updater.dart';
import '../platform/caps.dart';
import '../links.dart';

/// 控制菜单的一项：手机上推入页面，桌面列表栏里点选后在主区打开。
class ControlItem {
  final String id, group, title;
  final IconData icon;
  final String Function() subtitle;
  final Widget Function() page;
  final int Function()? badge;
  const ControlItem(this.id, this.group, this.icon, this.title, this.subtitle, this.page, {this.badge});
}

/// 所有控制页，按组：身份 → 日常 → 安全 → 连接 → 运维，越往下越偏技术。
List<ControlItem> controlItems() {
  final s = api.status;
  final hearing = (s['hearing'] as Map?) ?? {};
  return [
    ControlItem('identity', '身份', Icons.badge, '身份', () => '${api.name} · 名字、代词、简介、主题色', () => const IdentityPage()),
    ControlItem('autonomy', '日常', Icons.self_improvement, '自主性', () => '活跃度 ${s['activity'] ?? 1}× · ${s['paused'] == true ? '已暂停' : '进行中'}', () => const AutonomyPage()),
    ControlItem('approvals', '日常', Icons.gavel, '审批', () => '${api.approvals.length} 个待处理', () => const ApprovalsPage(), badge: () => api.approvals.length),
    ControlItem('tools', '日常', Icons.handyman, '工具', () => '她自己造的工具与技能文档：查看、停用、删除', () => const ToolsPage()),
    ControlItem('permissions', '安全', Icons.verified_user, '能力授权', () => '她能做什么、需要问你什么', () => const PermissionsPage()),
    ControlItem('budget', '安全', Icons.savings, '预算', () => '今日 ${(s['usage'] as Map?)?['tokens'] ?? 0} tokens', () => const BudgetPage()),
    ControlItem('audit', '安全', Icons.receipt_long, '审计日志', () => '每一次动作与修改', () => const AuditPage()),
    ControlItem('secrets', '安全', Icons.key, '保密库', () => '你保密交给她的密码、令牌：她能用，看不到明文', () => const SecretsPage()),
    ControlItem('providers', '连接', Icons.hub, '模型', () => '${(s['models'] as List?)?.length ?? 0} 个可用模型 · 供应商、Key 与顺序', () => const ProvidersPage()),
    ControlItem('feishu', '连接', Icons.send, '飞书', () => '一键扫码接入，在飞书里和她说话', () => const FeishuPage()),
    ControlItem('voice', '连接', Icons.record_voice_over, '语音', () => 'Azure 语音：她的声音、音色与风格（她自己也可以调）', () => const VoicePage()),
    ControlItem('hearing', '连接', Icons.hearing, '听觉', () => hearing['enabled'] == true ? (hearing['listening'] == true ? '开着：手机在听' : '开着，此刻没在听') : '关着 · 让她用麦克风听你说话', () => const HearingPage()),
    ControlItem('soul', '连接', Icons.cloud_sync, '灵魂同步', () => '与其他身体共享人格与记忆', () => const SoulPage()),
    ControlItem('mesh', '连接', Icons.lan, '多具身体', () => _meshSubtitle(), () => const MeshPage()),
    ControlItem('account', '连接', Icons.account_circle_outlined, '账户', () => '同步服务上的账户：agent 与身体、批准设备、控制台登录', () => const AccountPage()),
    ControlItem('history', '连接', Icons.history, '记忆历史', () => '每一次变更来自哪具身体，可查看与撤销', () => const HistoryPage()),
    ControlItem('service', '运维', Icons.monitor_heart, '服务', () => '版本 ${s['version'] ?? '-'} · 身体 ${s['body'] ?? '-'}（${s['adapter'] ?? '-'}）', () => const ServicePage()),
    ControlItem('about', '运维', Icons.info_outline, '关于', () => '简介 · 版本 · 检查更新与升级', () => const AboutPage()),
  ];
}

String _meshSubtitle() {
  final m = (api.status['mesh'] as Map?) ?? {};
  if (m['bound'] != true) return '把几部手机、几台电脑连成一个她';
  final n = api.peers.length;
  final c = '${m['coordinator'] ?? ''}';
  return n == 0 ? '已绑定 · 其他身体都不在线' : '$n 具身体在线 · 心跳在${c == api.body ? '这里' : ' $c'}';
}

/// 控制菜单：手机 Tab 页；桌面列表栏（selected / onSelect 给桌面用）。
class ControlPage extends ApiWidget {
  final String? selected;
  final void Function(ControlItem item)? onSelect;
  const ControlPage({super.key, this.selected, this.onSelect});
  @override
  Widget view(BuildContext context) {
    final desktop = ShellScope.isDesktop(context);
    Widget header(String t) => Padding(padding: EdgeInsets.fromLTRB(16, desktop ? 12 : 16, 16, 4), child: Text(t, style: Theme.of(context).textTheme.labelLarge?.copyWith(color: desktop ? Theme.of(context).colorScheme.onSurfaceVariant : null)));
    final items = controlItems();
    String? group;
    return ListView(padding: EdgeInsets.only(bottom: desktop ? 24 : 0), children: [
      for (final it in items) ...[
        if (it.group != group) header(group = it.group),
        ListTile(
          dense: desktop,
          selected: selected == it.id,
          leading: Badge(isLabelVisible: (it.badge?.call() ?? 0) > 0, label: Text('${it.badge?.call() ?? 0}'), child: Icon(it.icon, size: desktop ? 20 : null)),
          title: Text(it.title),
          subtitle: desktop ? null : Text(it.subtitle()),
          trailing: desktop ? null : const Icon(Icons.chevron_right),
          onTap: () => onSelect != null ? onSelect!(it) : Navigator.push(context, MaterialPageRoute(builder: (_) => it.page())),
        ),
      ],
    ]);
  }
}

// ---------------------------------------------------------------- 自主性
class AutonomyPage extends StatelessWidget {
  const AutonomyPage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '自主性',
        body: ListenableBuilder(listenable: api, builder: (context, _) {
          final s = api.status, h = api.heart, p = (h['personality'] as Map?) ?? {};
          final activity = ((s['activity'] ?? 1) as num).toDouble();
          return ListView(children: [
            Section('活跃度 ${activity.toStringAsFixed(1)}×', [
              const Text('醒来率的整体倍率。不是定时：只是让她整体更容易或更不容易醒来。'),
              Slider(value: activity.clamp(0, 3), min: 0, max: 3, divisions: 12, label: '${activity.toStringAsFixed(2)}×',
                  onChanged: (_) {}, onChangeEnd: (v) => act(context, () => api.call('activity', {'value': v}))),
            ]),
            SwitchListTile(
              title: const Text('暂停自主'), subtitle: const Text('她保持在线，会回应你，但不会自己醒来'),
              value: s['paused'] == true, onChanged: (v) => act(context, () => api.call('pause', {'paused': v})),
            ),
            Section('她的性格参数', [
              const Text('这些参数她自己也可以调整。时间常数越小，对应的驱动力涨得越快。', style: TextStyle(fontSize: 12)),
              for (final e in {'好奇心涨满（小时）': 'tau.curiosity', '表达欲涨满（小时）': 'tau.expression', '想念涨满（小时）': 'tau.social'}.entries)
                _Param(e.key, e.value, ((p['tau'] as Map?)?[e.value.split('.')[1]] ?? 3 as num).toDouble(), 0.5, 48),
              _Param('困意积累（小时）', 'sleepRiseH', ((p['sleepRiseH'] ?? 16) as num).toDouble(), 6, 30),
              _Param('睡眠恢复（小时）', 'sleepFallH', ((p['sleepFallH'] ?? 4) as num).toDouble(), 1, 10),
              _Param('最清醒的时刻', 'circadianPeakHour', ((p['circadianPeakHour'] ?? 16) as num).toDouble(), 0, 23.9),
            ]),
          ]);
        }),
      );
}

class _Param extends StatelessWidget {
  final String label, key0;
  final double value, min, max;
  const _Param(this.label, this.key0, this.value, this.min, this.max);
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$label：${value.toStringAsFixed(1)}'),
        Slider(value: value.clamp(min, max), min: min, max: max, onChanged: (_) {},
            onChangeEnd: (v) => act(context, () => api.call('personality', {'changes': {key0: double.parse(v.toStringAsFixed(1))}}))),
      ]);
}

// ---------------------------------------------------------------- 审批
class ApprovalsPage extends StatelessWidget {
  const ApprovalsPage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '审批',
        body: ListenableBuilder(listenable: api, builder: (context, _) => ListView(children: [
          if (api.approvals.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('没有待处理的请求', textAlign: TextAlign.center)),
          for (final a in api.approvals) ApprovalCard(a as Map),
        ])),
      );
}

/// 一条待审批：理由（Markdown）、参数、批准 / 拒绝。compact：只有理由与按钮（「她此刻」面板）。
class ApprovalCard extends StatelessWidget {
  final Map a;
  final bool compact;
  const ApprovalCard(this.a, {super.key, this.compact = false});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final buttons = Row(mainAxisAlignment: MainAxisAlignment.end, children: [
      TextButton(onPressed: () => act(context, () => api.call('decide', {'id': a['id'], 'approve': false})), child: const Text('拒绝')),
      FilledButton(onPressed: () => act(context, () => api.call('decide', {'id': a['id'], 'approve': true})), child: const Text('批准')),
    ]);
    if (compact) {
      return Padding(padding: const EdgeInsets.only(bottom: 4), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${a['action']}${a['body'] != null && a['body'] != api.body ? '（在 ${a['body']} 上）' : ''}', style: t.titleSmall),
        Text(plainPreview('${a['reason']}'), maxLines: 3, overflow: TextOverflow.ellipsis, style: t.bodySmall),
        buttons,
      ]));
    }
    return Section('${a['action']}', [
      if (a['body'] != null && a['body'] != api.body) Text('在 ${a['body']} 上请求的，批准后在那具身体上执行', style: t.bodySmall),
      Text('理由', style: t.labelLarge),
      RichMarkdown('${a['reason']}'),
      const SizedBox(height: 6),
      Text('参数', style: t.labelLarge),
      SelectableText(_json(a['args']), style: t.bodySmall?.copyWith(fontFamily: 'monospace')),
      buttons,
    ]);
  }
}

// ---------------------------------------------------------------- 能力授权
class PermissionsPage extends StatefulWidget {
  const PermissionsPage({super.key});
  @override
  State<PermissionsPage> createState() => _PermissionsPageState();
}

class _PermissionsPageState extends State<PermissionsPage> {
  List perms = [];
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { final r = await act(context, () => api.call<List>('permissions')); if (mounted && r != null) setState(() => perms = r); }
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '能力授权',
        body: ListView(children: [
          const Padding(padding: EdgeInsets.all(16), child: Text('她调用每一类能力前都会经过这里。选「询问」时，她会先请求你批准（控制台与飞书都能批准）。')),
          for (final p in perms)
            ListTile(
              title: Text('${p['label']}'),
              subtitle: SegmentedButton<String>(
                segments: const [ButtonSegment(value: 'allow', label: Text('允许')), ButtonSegment(value: 'ask', label: Text('询问')), ButtonSegment(value: 'deny', label: Text('禁止'))],
                selected: {p['level'] as String},
                onSelectionChanged: (v) async { await act(context, () => api.call('setPermission', {'id': p['id'], 'level': v.first})); _load(); },
              ),
            ),
        ]),
      );
}

// ---------------------------------------------------------------- 预算
class BudgetPage extends StatefulWidget {
  const BudgetPage({super.key});
  @override
  State<BudgetPage> createState() => _BudgetPageState();
}

class _BudgetPageState extends State<BudgetPage> {
  Map? b;
  final c = <String, TextEditingController>{};
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('budget'));
    if (!mounted || r == null) return;
    setState(() { b = r; for (final k in ['dailyTokens', 'dailyCostUsd', 'minBattery', 'maxTempC']) { c[k] = TextEditingController(text: '${r[k]}'); } });
  }
  @override
  Widget build(BuildContext context) {
    final b = this.b;
    return PageFrame(
      title: '预算',
      body: b == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        Section('今日用量', [
          Text('${b['usage']['tokens']} / ${b['dailyTokens']} tokens'),
          LinearProgressIndicator(value: ((b['usage']['tokens'] as num) / (b['dailyTokens'] as num)).clamp(0, 1).toDouble()),
          const SizedBox(height: 8),
          Text('\$${(b['usage']['cost'] as num).toStringAsFixed(3)} / \$${b['dailyCostUsd']}'),
          const Text('超出后她会几乎不再醒来，第二天自动恢复。', style: TextStyle(fontSize: 12)),
        ]),
        Section('上限', [
          for (final e in {'dailyTokens': '每日 token 上限', 'dailyCostUsd': '每日花费上限（美元，0 表示不限）', 'minBattery': '最低电量 %（低于且未充电时少醒）', 'maxTempC': '最高温度 °C（超过时少醒）'}.entries)
            Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: TextField(controller: c[e.key], keyboardType: TextInputType.number, decoration: InputDecoration(labelText: e.value, border: const OutlineInputBorder()))),
          FilledButton(onPressed: () async {
            await act(context, () => api.call('setBudget', {for (final k in c.keys) k: num.tryParse(c[k]!.text) ?? b[k]}), ok: '已保存');
            _load();
          }, child: const Text('保存')),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------- 审计
class AuditPage extends StatelessWidget {
  const AuditPage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '审计日志',
        body: FutureBuilder<List>(
          future: api.call<List>('audit', {'limit': 200}),
          builder: (_, s) => !s.hasData
              ? Center(child: s.hasError ? Text('${s.error}') : const CircularProgressIndicator())
              : ListView(children: [
                  for (final a in s.data!)
                    ListTile(
                      dense: true,
                      title: Text('${a['actor']} · ${a['action']}'),
                      subtitle: Text('${hm(a['ts'])}  ${a['reason'] ?? ''}\n${plainPreview('${a['result'] ?? ''}')}', maxLines: 3, overflow: TextOverflow.ellipsis),
                      onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => _AuditDetail(a as Map))),
                    ),
                ]),
        ),
      );
}

/// 一条审计记录的完整内容：参数（JSON）与输出（像 Markdown 就按 Markdown 渲染，否则原样等宽）。
class _AuditDetail extends StatelessWidget {
  final Map a;
  const _AuditDetail(this.a);
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return PageFrame(
      title: '${a['actor']} · ${a['action']}',
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('${hm(a['ts'])}${'${a['reason'] ?? ''}'.isNotEmpty ? ' · ${a['reason']}' : ''}', style: t.bodySmall),
        const SizedBox(height: 12),
        Text('参数', style: t.labelLarge),
        SelectableText(_json(a['args']), style: t.bodySmall?.copyWith(fontFamily: 'monospace')),
        const SizedBox(height: 12),
        Text('结果', style: t.labelLarge),
        if ('${a['result'] ?? ''}'.isEmpty) Text('（无）', style: t.bodySmall) else RawOrMarkdown('${a['result']}'),
      ]),
    );
  }
}

/// 参数的可读形式：已是 JSON 字符串就整理缩进，否则直接编码。
String _json(Object? v) {
  try {
    final o = v is String ? jsonDecode(v) : v;
    return o == null ? '（无）' : const JsonEncoder.withIndent('  ').convert(o);
  } catch (_) { return '$v'; }
}

// ---------------------------------------------------------------- 保密库
/// 你通过保密输入（她调用 pass_secret 时）交给她的值：只列名字与说明，任何地方都不显示内容；可以删除。
class SecretsPage extends StatefulWidget {
  const SecretsPage({super.key});
  @override
  State<SecretsPage> createState() => _SecretsPageState();
}

class _SecretsPageState extends State<SecretsPage> {
  List? list;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { final r = await act(context, () => api.call<List>('secrets')); if (mounted && r != null) setState(() => list = r); }
  @override
  Widget build(BuildContext context) {
    final list = this.list;
    return PageFrame(
      title: '保密库',
      body: list == null ? const Center(child: CircularProgressIndicator()) : ListView(children: [
        Padding(padding: const EdgeInsets.all(16), child: Text('${api.name} 需要密码、令牌、密钥时，会在对话里请你「保密输入」：你发的内容不进入对话，直接存到这里。她只能在命令里按路径引用，看不到明文；这里也不显示内容。它们只在这具身体上，不会同步到别的身体。')),
        if (list.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('还没有保密值', textAlign: TextAlign.center)),
        for (final s in list.cast<Map>())
          ListTile(
            leading: const Icon(Icons.key),
            title: Text('${s['name']}'),
            subtitle: Text('${'${s['hint']}'.isEmpty ? '' : '${s['hint']}\n'}${hm(s['ts'])}${'${s['channel']}'.isEmpty ? '' : ' · 来自${s['channel']}'} · ${s['bytes']} 字节'),
            isThreeLine: '${s['hint']}'.isNotEmpty,
            trailing: IconButton(tooltip: '删除', icon: const Icon(Icons.delete_outline), onPressed: () async {
              if (!await confirm(context, '删除保密值', '删除「${s['name']}」？她将无法再使用它，需要时得请你重新输入。') || !context.mounted) return;
              await act(context, () => api.call('secrets.delete', {'name': s['name']}), ok: '已删除');
              _load();
            }),
          ),
      ]),
    );
  }
}

// ---------------------------------------------------------------- 飞书
class FeishuPage extends StatefulWidget {
  const FeishuPage({super.key});
  @override
  State<FeishuPage> createState() => _FeishuPageState();
}

class _FeishuPageState extends State<FeishuPage> {
  Map? st;
  String? qr, error;
  final appId = TextEditingController(), secret = TextEditingController();
  @override
  void initState() {
    super.initState();
    _load();
    api.events.listen((e) {
      if (!mounted) return;
      if (e.name == 'feishu.qr') setState(() => qr = (e.data as Map)['url']);
      if (e.name == 'feishu.registered') { setState(() => qr = null); toast(context, '飞书机器人已创建并绑定'); _load(); }
      if (e.name == 'feishu.error') setState(() { qr = null; error = '${(e.data as Map)['message']}'; });
    });
  }
  Future<void> _load() async { final r = await act(context, () => api.call<Map>('feishu.status')); if (mounted && r != null) setState(() => st = r); }

  @override
  Widget build(BuildContext context) {
    final st = this.st;
    return PageFrame(
      title: '飞书',
      body: st == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        Section('状态', [
          ListTile(contentPadding: EdgeInsets.zero, leading: Icon(st['connected'] == true ? Icons.check_circle : Icons.cancel, color: st['connected'] == true ? Colors.green : Colors.grey),
              title: Text(st['connected'] == true ? '已连接' : st['appId'] == '' ? '尚未接入' : '未连接'),
              subtitle: Text('${st['appId'] == '' ? '' : 'App ID：${st['appId']}　'}${st['owner'] == true ? '已绑定你' : '未绑定'}${st['error'] != '' ? '\n${st['error']}' : ''}')),
          if (st['appId'] != '') SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('启用'), value: st['enabled'] == true, onChanged: (v) async { await act(context, () => api.call('feishu.set', {'enabled': v})); _load(); }),
          if (st['appId'] != '' && st['owner'] != true) Text('绑定：在飞书里给机器人发送绑定码 ${st['bindCode']}'),
        ]),
        if (api.peers.isNotEmpty || '${st['holder'] ?? ''}'.isNotEmpty) Section('多具身体：谁持有飞书', [
          const Text('同一个飞书机器人只能由一具身体连接（否则每条消息会随机落到其中一具）。其他身体想主动发的消息会转给它发出，你在飞书里说的话也会转到正在和你说话的那具身体。'),
          DropdownButton<String>(
            value: '${st['holder'] ?? ''}',
            items: [
              const DropdownMenuItem(value: '', child: Text('各自连接（只有一具身体时）')),
              for (final b in {api.body, ...api.peers.map((p) => '${p['body']}'), if ('${st['holder'] ?? ''}'.isNotEmpty) '${st['holder']}'}) DropdownMenuItem(value: b, child: Text(b == api.body ? '$b（这具身体）' : b)),
            ],
            onChanged: (v) async { await act(context, () => api.call('feishu.setHolder', {'body': v ?? ''}), ok: '已保存'); _load(); },
          ),
          if (st['holds'] == false) Text('这具身体不连飞书，由 ${st['holder']} 持有。', style: Theme.of(context).textTheme.bodySmall),
        ]),
        Section('一键接入（推荐）', [
          Text('自动创建一个名为「${api.name}」的飞书机器人，权限、事件与卡片回调都会预先配置好；确认后自动绑定你本人。'),
          const SizedBox(height: 8),
          if (qr == null) FilledButton.icon(icon: const Icon(Icons.qr_code), label: const Text('开始'), onPressed: () { setState(() => error = null); act(context, () => api.call('feishu.register')); }),
          if (qr != null) ...[
            FilledButton.icon(icon: const Icon(Icons.open_in_new), label: const Text('在飞书中打开并确认'), onPressed: () => openExternal(context, qr!)),
            const SizedBox(height: 8),
            const Text('或者用另一台手机的飞书扫码：'),
            Center(child: Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: qr!, size: 200))),
            const Text('等待确认中…'),
          ],
          if (error != null) Text(error!, style: const TextStyle(color: Colors.red)),
          const SizedBox(height: 8),
          const Text('可选：在飞书开发者后台「机器人 → 自定义菜单」添加推送事件 home / flow / memory / control，就能在聊天框底部一键打开对应卡片。', style: TextStyle(fontSize: 12)),
        ]),
        ExpansionTile(title: const Text('手动填写凭据'), children: [
          TextField(controller: appId, decoration: const InputDecoration(labelText: 'App ID')),
          TextField(controller: secret, obscureText: true, decoration: const InputDecoration(labelText: 'App Secret')),
          TextButton(onPressed: () async { await act(context, () => api.call('feishu.set', {'appId': appId.text.trim(), 'appSecret': secret.text.trim(), 'enabled': true}), ok: '已保存'); _load(); }, child: const Text('保存并连接')),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------- 灵魂同步
class SoulPage extends StatefulWidget {
  const SoulPage({super.key});
  @override
  State<SoulPage> createState() => _SoulPageState();
}

class _SoulPageState extends State<SoulPage> {
  Map? cfg;
  String? pub;
  String mode = 'deploy'; // 访问方式：deploy 本机部署密钥 / custom 指定私钥 / system 系统 ssh 配置
  final remote = TextEditingController(), keyPath = TextEditingController();
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('soulConfig'));
    if (mounted && r != null) setState(() { cfg = r; remote.text = '${r['remote']}'; mode = '${r['sshMode'] ?? 'deploy'}'; keyPath.text = '${r['sshKeyPath'] ?? ''}'; });
  }
  Future<void> _connect() async {
    await act(context, () => api.call('setSoulConfig', {'remote': remote.text.trim(), 'sshMode': mode, 'sshKeyPath': keyPath.text.trim()}), ok: '已接入');
    _load();
  }
  @override
  Widget build(BuildContext context) {
    final cfg = this.cfg;
    return PageFrame(
      title: '灵魂同步',
      body: cfg == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        const Padding(padding: EdgeInsets.all(4), child: Text('她可以同时住在多具身体里（例如另一台运行 Hermes 的设备）。所有身体共享一个私有 git 仓库：人格、常驻记忆、笔记与日记。每次醒来前拉取，醒来后推送。')),
        // 本机状态跟着 status.soul 实时刷新（后台的同步也会更新这里），不只在打开页面时取一次
        ListenableBuilder(listenable: api, builder: (context, _) {
          final st = (api.status['soul'] as Map?) ?? (cfg['status'] as Map?) ?? {};
          return Section('本机', [
            Text('身体名称：${cfg['body']}'),
            Text('上次拉取：${(st['lastPull'] ?? 0) == 0 ? '从未' : hm(st['lastPull'])}　上次推送：${(st['lastPush'] ?? 0) == 0 ? '从未' : hm(st['lastPush'])}'),
            if ('${st['lastError'] ?? ''}'.isNotEmpty) Text('${st['lastError']}', style: const TextStyle(color: Colors.red)),
            FilledButton.tonal(onPressed: () async { await act(context, () => api.call('syncSoul'), ok: '已同步'); _load(); }, child: const Text('立即同步')),
          ]);
        }),
        Section('1. 访问仓库用哪把钥匙', [
          SegmentedButton<String>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: 'deploy', label: Text('本机部署密钥')),
              ButtonSegment(value: 'custom', label: Text('指定私钥')),
              ButtonSegment(value: 'system', label: Text('系统 ssh 配置')),
            ],
            selected: {mode},
            onSelectionChanged: (v) => setState(() => mode = v.first),
          ),
          const SizedBox(height: 10),
          if (mode == 'deploy') ...[
            const Text('每具身体一把专属的 ed25519 密钥，在本机生成。把下面的公钥添加到灵魂仓库网页的「Deploy keys」，并勾选「允许写入」。'),
            if (pub != null) SelectableText(pub!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            TextButton(onPressed: () async { final k = await act(context, () => api.call<String>('soulKey')); if (mounted) setState(() => pub = k); }, child: Text(pub == null ? '显示公钥' : '已生成')),
          ],
          if (mode == 'custom') ...[
            const Text('用你已有的一把私钥（只用它，不回退到 ssh-agent）。路径在运行基座所在的机器上，支持 ~。'),
            const SizedBox(height: 8),
            TextField(controller: keyPath, decoration: const InputDecoration(labelText: '私钥路径，例如 ~/.ssh/id_ed25519', border: OutlineInputBorder())),
          ],
          if (mode == 'system') const Text('不指定私钥，交给运行基座所在机器的 ~/.ssh/config（Host 别名、IdentityFile）与 ssh-agent。注意：运行基座以服务方式在后台运行，往往拿不到你登录会话的 ssh-agent，建议在 ~/.ssh/config 里为这个 Host 写明 IdentityFile。'),
        ]),
        Section('2. 灵魂仓库地址', [
          TextField(controller: remote, decoration: const InputDecoration(labelText: '例如 git@github.com:你的用户名/<agent>.soul.git（~/.ssh/config 里的 Host 别名也可以）', border: OutlineInputBorder())),
          const SizedBox(height: 8),
          FilledButton(onPressed: _connect, child: const Text('接入')),
          const Text('仓库必须是私有的。首次接入时，若仓库里已有另一具身体的人格，会直接采用它，并合并两边的记忆。改了钥匙方式也点「接入」保存。', style: TextStyle(fontSize: 12)),
        ]),
        Section('3. 让 Hermes / OpenClaw 也住进来', [
          const Text('在装有 Hermes Agent 或 OpenClaw 的机器上，把下面这句话发给它。它会自己安装 soul-bridge，之后人格与记忆全自动同步，随时可以拔出。'),
          SelectableText(_bridgePrompt(remote.text.trim())),
          TextButton.icon(icon: const Icon(Icons.copy), label: const Text('复制'), onPressed: () { Clipboard.setData(ClipboardData(text: _bridgePrompt(remote.text.trim()))); toast(context, '已复制'); }),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------- 服务
/// 命令执行的沙箱（status.sandbox.kind：bwrap | proot | none；旧版运行基座没有这一项，不显示）。none 时提醒。
List<Widget> sandboxLines(BuildContext context, String sb) => [
      Text('命令沙箱：${switch (sb) { 'bwrap' => 'bubblewrap（bwrap）', 'proot' => 'proot', 'none' => '无', _ => sb }}'),
      if (sb == 'none') Text('没有可用的沙箱：她执行的命令直接以运行基座的身份运行，能读写这个用户的全部文件。Linux 请安装 bubblewrap，Termux 请安装 proot，然后重启运行基座。',
          style: TextStyle(color: Theme.of(context).colorScheme.error)),
    ];
class ServicePage extends StatelessWidget {
  const ServicePage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '服务',
        body: ListenableBuilder(listenable: api, builder: (context, _) {
          final s = api.status, p = api.physical, sys = (p['system'] as Map?) ?? {};
          return ListView(children: [
            Section('运行状态', [
              Text('连接：${api.conn.name}${api.safeMode ? '（安全模式）' : ''}'),
              Text('版本：${s['version'] ?? '-'}'),
              Text('身体：${s['body'] ?? '-'} · 适配器 ${s['adapter'] ?? '-'}'),
              if (s['sandbox'] is Map && (s['sandbox'] as Map)['kind'] is String) ...sandboxLines(context, (s['sandbox'] as Map)['kind'] as String),
              Text('系统：已运行 ${sys['uptimeH'] ?? '-'} 小时 · 负载 ${sys['load1'] ?? '-'} · 空闲内存 ${sys['memFreeMB'] ?? '-'} MB · 存储余量 ${sys['storageFreeGB'] ?? '-'} GB'),
              Text('模型：${((s['models'] as List?) ?? []).join('、')}'),
              if (hasBody) FutureBuilder(future: Installer.bundledVersion(), builder: (_, v) => Text('App 内置的运行基座：${v.data ?? '（无）'}${v.data != null && s['version'] != null && v.data != s['version'] ? '，与运行中的不同，可升级' : ''}')),
              if (!hasBody) Text(isDesktop ? '升级：在这台机器上再跑一次安装命令（curl -fsSL https://quetzal.plutokeating.beer/install | bash），运行基座与这个控制台一起更新。' : '网页版由运行基座自己托管；升级在装它的那台机器上再跑一次安装命令（curl -fsSL https://quetzal.plutokeating.beer/install | bash）或 npx @plutokeating/quetzal。'),
            ]),
            const _SupervisionSection(),
            Section('操作', [
              Wrap(spacing: 8, children: [
                if (hasBody) FilledButton.tonal(onPressed: () async { final e = await api.ignite(); if (e != null && context.mounted) toast(context, e); }, child: const Text('点火')),
                if (hasBody) FilledButton.tonal(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage(upgrade: true))), child: const Text('升级 / 重装')),
                FilledButton.tonal(onPressed: () async { if (await confirm(context, '重启基座', '重启运行基座进程？约 5 秒后恢复。') && context.mounted) await act(context, () => api.call('restart'), ok: '正在重启'); }, child: const Text('重启')),
                OutlinedButton(onPressed: () async {
                  if (await confirm(context, '重新配对', '将清除本机保存的令牌，需要重新获取配对码。')) await api.saveSettings(token: '');
                }, child: const Text('重新配对')),
              ]),
            ]),
          ]);
        }),
      );
}

/// Quetzal App 自身的更新（只在安卓）：问 GitHub 最新正式版 → 一键下载、核对、交给系统安装器。装好新 App 后运行基座的升级由外壳横幅接管。
class AppUpdateSection extends StatefulWidget {
  const AppUpdateSection({super.key});
  @override
  State<AppUpdateSection> createState() => _AppUpdateSectionState();
}

class _AppUpdateSectionState extends State<AppUpdateSection> {
  @override
  void initState() { super.initState(); if (appUpdater.current == null) appUpdater.currentVersion().then((_) { if (mounted) setState(() {}); }); }
  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: appUpdater, builder: (context, _) {
    final u = appUpdater, r = u.latest, t = Theme.of(context).textTheme;
    final busy = u.busy;
    return Section('Quetzal App', [
      Text('当前版本：${u.current ?? '-'}${u.state == UpdateState.upToDate ? '，已是最新' : ''}'),
      if (u.state == UpdateState.available && r != null) Text('新版本 ${r.version}${r.sizeText.isEmpty ? '' : '（${r.sizeText}）'}。装好后打开 Quetzal，它会提示把运行基座也升级到新版，记忆与配置都保留。'),
      if (u.state == UpdateState.downloading) ...[
        Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: LinearProgressIndicator(value: u.progress < 0 ? null : u.progress)),
        Text(u.progress < 0 ? '下载中' : '下载中 ${(u.progress * 100).toStringAsFixed(0)}%', style: t.bodySmall),
      ],
      if (u.state == UpdateState.verifying) Text('核对安装包', style: t.bodySmall),
      if (u.state == UpdateState.needPermission) const Text('系统需要你允许 Quetzal 安装应用：在刚打开的设置页里开启，回到这里再点「安装」。安装包已经下载好了。'),
      if (u.state == UpdateState.handedOff) const Text('已交给系统安装器。安装完成后打开 Quetzal，它会接着把运行基座升级到新版。'),
      if (u.state == UpdateState.failed && u.error != null) Text(u.error!, style: t.bodyMedium?.copyWith(color: Colors.red)),
      const SizedBox(height: 6),
      Wrap(spacing: 8, runSpacing: 4, children: [
        if (u.state == UpdateState.available || u.state == UpdateState.needPermission || u.state == UpdateState.handedOff)
          FilledButton.icon(onPressed: busy ? null : () => u.state == UpdateState.available ? u.downloadAndInstall() : u.install(),
              icon: const Icon(Icons.system_update), label: Text(u.state == UpdateState.available ? '下载并安装' : '安装')),
        if (u.state == UpdateState.failed && r != null && u.hasUpdate) FilledButton.tonal(onPressed: u.downloadAndInstall, child: const Text('重试')),
        if (u.state != UpdateState.available && u.state != UpdateState.needPermission)
          OutlinedButton(onPressed: busy ? null : u.check, child: Text(u.state == UpdateState.checking ? '检查中' : '检查新版本')),
        if (r != null) TextButton(onPressed: () => openExternal(context, r.url), child: const Text('发布说明')),
        if (u.state == UpdateState.failed) TextButton(onPressed: () => openExternal(context, downloadPage), child: const Text('去下载页')),
      ]),
    ]);
  });
}

/// 守护开关：开机自启 + 退出后自动重启，一个开关管两件事。由身体适配器实现（Linux：systemd 用户服务或守护循环；安卓：runit + Termux:Boot）；没有守护者的身体不显示。
class _SupervisionSection extends StatefulWidget {
  const _SupervisionSection();
  @override
  State<_SupervisionSection> createState() => _SupervisionSectionState();
}

class _SupervisionSectionState extends State<_SupervisionSection> {
  Map? st;
  bool busy = false;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    try { final r = await api.call<Map>('supervision'); if (mounted) setState(() => st = r); } catch (_) {}
  }
  @override
  Widget build(BuildContext context) {
    final s = st;
    if (s == null || s['available'] != true) return const SizedBox.shrink();
    final on = s['enabled'] == true;
    return Section('守护', [
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('开机自启 · 崩溃或意外退出后自动重启'),
        subtitle: Text('${s['detail'] ?? ''}${on ? '' : '\n已关闭：正在运行的进程不受影响，但退出后不会再被拉起，重启后也不会自己醒来。'}'),
        value: on,
        onChanged: busy ? null : (v) async {
          setState(() => busy = true);
          final r = await act(context, () => api.call<Map>('setSupervision', {'enabled': v}), ok: v ? '已开启守护' : '已关闭守护');
          if (mounted) setState(() { busy = false; if (r != null) st = r; });
        },
      ),
    ]);
  }
}

String _bridgePrompt(String repo) =>
    '请安装 soul-bridge 技能（https://github.com/PlutoKeating/Project.Quetzal/tree/main/bridge/skills/soul-bridge），'
    '按技能说明把你接入灵魂仓库 ${repo.isEmpty ? '<仓库地址>' : repo}，需要我配合的步骤告诉我。';

// ---------------------------------------------------------------- 语音（Azure 语音服务）
class VoicePage extends StatefulWidget {
  const VoicePage({super.key});
  @override
  State<VoicePage> createState() => _VoicePageState();
}

class _VoicePageState extends State<VoicePage> {
  static const fields = {'region': '区域（如 eastasia、southeastasia）', 'endpoint': '自定义端点（可选，填了则忽略区域）', 'voice': '音色（如 zh-CN-XiaoxiaoNeural）', 'style': '默认风格（可选，如 cheerful、gentle）', 'rate': '语速（如 0%、+10%）', 'pitch': '音调（如 0%、-5%）', 'volume': '音量（0–100）', 'format': '输出格式'};
  final c = {for (final k in fields.keys) k: TextEditingController()};
  final key = TextEditingController(), sample = TextEditingController(text: '你好，这是我的声音。');
  Map? st;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('speech'));
    if (!mounted || r == null) return;
    setState(() { st = r; for (final k in fields.keys) { c[k]!.text = '${r[k] ?? ''}'; } });
  }
  Future<void> _save() async {
    await act(context, () => api.call('setSpeech', {for (final k in fields.keys) k: c[k]!.text.trim(), if (key.text.trim().isNotEmpty) 'key': key.text.trim()}), ok: '已保存');
    key.clear(); _load();
  }
  Future<void> _pickVoice() async {
    final list = await act(context, () => api.call<List>('speechVoices', {'locale': c['voice']!.text.split('-').take(2).join('-').isEmpty ? 'zh-CN' : c['voice']!.text.split('-').take(2).join('-')}));
    if (list == null || !mounted) return;
    final v = await showDialog<Map>(context: context, builder: (x) => SimpleDialog(title: const Text('选择音色'), children: [
      for (final e in list.cast<Map>()) SimpleDialogOption(onPressed: () => Navigator.pop(x, e),
          child: Text('${e['local']} · ${e['name']}（${e['gender']}）${(e['styles'] as List).isEmpty ? '' : '\n风格：${(e['styles'] as List).join(' / ')}'}')),
    ]));
    if (v != null) setState(() => c['voice']!.text = '${v['name']}');
  }

  @override
  Widget build(BuildContext context) {
    final st = this.st;
    return PageFrame(
      title: '语音',
      body: st == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        Section('状态', [
          ListTile(contentPadding: EdgeInsets.zero, leading: Icon(st['configured'] == true ? Icons.check_circle : Icons.info_outline, color: st['configured'] == true ? Colors.green : Colors.grey),
              title: Text(st['configured'] == true ? '已配置，她可以用自己的声音说话' : '尚未配置'),
              subtitle: Text('密钥：${'${st['keyLastFour']}'.isEmpty ? '未设置' : '****${st['keyLastFour']}'}。这些设置她也可以用 voice_config 工具自己修改。')),
        ]),
        Section('Azure 语音服务', [
          TextField(controller: key, obscureText: true, decoration: const InputDecoration(labelText: '密钥（留空则保持不变）', border: OutlineInputBorder())),
          for (final e in fields.entries) Padding(
            padding: const EdgeInsets.only(top: 8),
            child: TextField(controller: c[e.key], decoration: InputDecoration(labelText: e.value, border: const OutlineInputBorder(),
                suffixIcon: e.key == 'voice' ? IconButton(icon: const Icon(Icons.list), tooltip: '从列表选择', onPressed: _pickVoice) : null)),
          ),
          const SizedBox(height: 8),
          FilledButton(onPressed: _save, child: const Text('保存')),
        ]),
        Section('试听', [
          TextField(controller: sample, decoration: const InputDecoration(border: OutlineInputBorder())),
          const SizedBox(height: 8),
          OutlinedButton.icon(icon: const Icon(Icons.play_arrow), label: const Text('用当前配置说一句'), onPressed: () => act(context, () => api.call('speechTest', {'text': sample.text}), ok: '已播放')),
        ]),
      ]),
    );
  }
}
