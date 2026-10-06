// 控制：首屏只放常用的几项（模型 · 权限 · 节律 · 声音 · 飞书 · 设备），其余收进「高级」，最后是「关于」。
// 审批的理由按 Markdown 渲染；操作记录点开看完整参数与输出。性格参数、语音与听觉的细节由她自己调（adjust_self / voice_config / hearing_config），不放在这里。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import '../shell/nav.dart';
import 'providers.dart';
import 'agents.dart';
import 'setup.dart';
import 'about.dart';
import 'tools.dart';
import 'sound.dart';
import 'mesh.dart';
import 'account.dart';
import '../platform/caps.dart';
import '../links.dart';

/// 控制菜单的一项：手机上推入页面，桌面列表栏里点选后在主区打开。
/// group：head 顶部的身份 · main 首屏 · end 底部（高级、关于）· more 收在「高级」里 · hidden 从别的页面进入（账户从「设备」进）。
class ControlItem {
  final String id, group, title;
  final IconData icon;
  final String Function() status; // 右侧的一个短状态，没有就空
  final Widget Function() page;
  final int Function()? badge;
  const ControlItem(this.id, this.group, this.icon, this.title, this.status, this.page, {this.badge});
}

String _none() => '';

/// 所有控制页（含收在「高级」里的），桌面按 id 打开任何一页。
List<ControlItem> controlItems() {
  final s = api.status;
  final hearing = (s['hearing'] as Map?) ?? {};
  final models = (s['models'] as List?)?.length ?? 0;
  return [
    ControlItem('identity', 'head', Icons.badge_outlined, '身份', _none, () => const IdentityPage()),
    ControlItem('providers', 'main', Icons.hub_outlined, '模型', () => models == 0 ? '未设置' : '', () => const ProvidersPage()),
    ControlItem('permissions', 'main', Icons.verified_user_outlined, '权限', () => api.approvals.isEmpty ? '' : '${api.approvals.length} 个待批准', () => const PermissionsPage(), badge: () => api.approvals.length),
    ControlItem('autonomy', 'main', Icons.self_improvement, '节律', () => s['paused'] == true ? '已暂停' : '', () => const AutonomyPage()),
    ControlItem('voice', 'main', Icons.graphic_eq, '声音', () => hearing['listening'] == true ? '在听' : '', () => const SoundPage()),
    ControlItem('feishu', 'main', Icons.send_outlined, '飞书', _none, () => const FeishuPage()),
    ControlItem('mesh', 'main', Icons.devices_outlined, '设备', _meshStatus, () => const MeshPage()),
    ControlItem('more', 'end', Icons.tune, '高级', _none, () => const MorePage()),
    ControlItem('about', 'end', Icons.info_outline, '关于', _none, () => const AboutPage()),
    ControlItem('tools', 'more', Icons.handyman_outlined, '工具', _none, () => const ToolsPage()),
    ControlItem('secrets', 'more', Icons.key_outlined, '保密库', _none, () => const SecretsPage()),
    ControlItem('budget', 'more', Icons.savings_outlined, '预算', _none, () => const BudgetPage()),
    ControlItem('soul', 'more', Icons.cloud_sync_outlined, '同步', _none, () => const SoulPage()),
    ControlItem('history', 'more', Icons.history, '记忆历史', _none, () => const HistoryPage()),
    ControlItem('audit', 'more', Icons.receipt_long_outlined, '操作记录', _none, () => const AuditPage()),
    ControlItem('service', 'more', Icons.monitor_heart_outlined, '运行', _none, () => const ServicePage()),
    ControlItem('account', 'hidden', Icons.account_circle_outlined, '账户', _none, () => const AccountPage()),
  ];
}

/// 旧的位置（收藏的网址、旧版本的链接）对应到现在的页面。
const _aliases = {'approvals': 'permissions', 'hearing': 'voice'};

/// 按 id 找控制页；找不到就是身份页。
ControlItem controlItem(String? id) {
  final items = controlItems();
  final k = _aliases[id] ?? id;
  return items.where((it) => it.id == k).firstOrNull ?? items.first;
}

String _meshStatus() {
  final m = (api.status['mesh'] as Map?) ?? {};
  if (m['bound'] != true) return '';
  final n = api.peers.length;
  return n == 0 ? '' : '${n + 1} 台在线';
}

/// 控制菜单：手机 Tab 页；桌面列表栏（selected / onSelect 给桌面用）。
class ControlPage extends ApiWidget {
  final String? selected;
  final void Function(ControlItem item)? onSelect;
  const ControlPage({super.key, this.selected, this.onSelect});
  @override
  Widget view(BuildContext context) {
    final desktop = ShellScope.isDesktop(context);
    final cs = Theme.of(context).colorScheme, t = Theme.of(context).textTheme;
    final items = controlItems();
    // 收在「高级」里的页面打开时，菜单上亮「高级」；账户亮「设备」
    final sel = controlItem(selected);
    final lit = switch (sel.group) { 'more' => 'more', 'hidden' => 'mesh', _ => sel.id };
    void open(ControlItem it) => onSelect != null ? onSelect!(it) : Navigator.push(context, MaterialPageRoute(builder: (_) => it.page()));
    Widget tile(ControlItem it) {
      final st = it.status(), n = it.badge?.call() ?? 0;
      return ListTile(
        dense: desktop,
        selected: selected != null && lit == it.id,
        leading: Badge(isLabelVisible: n > 0, label: Text('$n'), child: Icon(it.icon, size: desktop ? 20 : null)),
        title: Text(it.title),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          if (st.isNotEmpty) Text(st, style: t.bodySmall?.copyWith(color: st == '未设置' ? cs.error : cs.onSurfaceVariant)),
          if (!desktop) const Icon(Icons.chevron_right),
        ]),
        onTap: () => open(it),
      );
    }
    final head = items.firstWhere((it) => it.group == 'head');
    final desc = '${api.agent['description'] ?? ''}';
    return ListView(padding: EdgeInsets.only(top: desktop ? 8 : 4, bottom: 24), children: [
      ListTile(
        selected: selected != null && lit == head.id,
        leading: CircleAvatar(backgroundColor: api.color, foregroundColor: const Color(0xFF1A120A), child: Text(api.name.isEmpty ? '·' : api.name.characters.first)),
        title: Text(api.name, style: desktop ? null : t.titleMedium),
        subtitle: desc.isEmpty ? null : Text(desc, maxLines: 1, overflow: TextOverflow.ellipsis),
        trailing: desktop ? null : const Icon(Icons.chevron_right),
        onTap: () => open(head),
      ),
      const Divider(indent: 16, endIndent: 16),
      for (final it in items.where((it) => it.group == 'main')) tile(it),
      const Divider(indent: 16, endIndent: 16),
      for (final it in items.where((it) => it.group == 'end')) tile(it),
    ]);
  }
}

/// 高级：不常用的页面。桌面上点选后在主区打开（地址栏记得住），手机上推入。
class MorePage extends StatelessWidget {
  const MorePage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '高级',
        body: ListView(children: [
          for (final it in controlItems().where((it) => it.group == 'more'))
            ListTile(
              leading: Icon(it.icon),
              title: Text(it.title),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => ShellScope.isDesktop(context) ? nav.go('control', id: it.id) : Navigator.push(context, MaterialPageRoute(builder: (_) => it.page())),
            ),
        ]),
      );
}

// ---------------------------------------------------------------- 节律
/// 活跃度与暂停。性格参数（驱动力的时间常数、困意、最清醒的时刻）由她自己用 adjust_self 调。
class AutonomyPage extends StatelessWidget {
  const AutonomyPage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '节律',
        body: ListenableBuilder(listenable: api, builder: (context, _) {
          final s = api.status, t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
          final activity = ((s['activity'] ?? 1) as num).toDouble();
          return ListView(padding: const EdgeInsets.all(12), children: [
            Section('活跃度', trailing: Text('${activity.toStringAsFixed(1)}×', style: t.bodySmall?.copyWith(color: cs.onSurfaceVariant)), [
              Slider(value: activity.clamp(0, 3), min: 0, max: 3, divisions: 12, label: '${activity.toStringAsFixed(2)}×',
                  onChanged: (_) {}, onChangeEnd: (v) => act(context, () => api.call('activity', {'value': v}))),
              Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: Row(children: [
                Text('安静', style: t.bodySmall?.copyWith(color: cs.onSurfaceVariant)), const Spacer(),
                Text('活跃', style: t.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
              ])),
            ]),
            Card(child: SwitchListTile(
              title: const Text('暂停'), subtitle: const Text('只在你找她时醒来'),
              value: s['paused'] == true, onChanged: (v) => act(context, () => api.call('pause', {'paused': v})),
            )),
          ]);
        }),
      );
}

// ---------------------------------------------------------------- 权限（待批准 + 各类能力）
/// 一条待审批：理由（Markdown）、参数（点开看）、批准 / 拒绝。compact：只有理由与按钮（「她此刻」面板）。
class ApprovalCard extends StatelessWidget {
  final Map a;
  final bool compact;
  const ApprovalCard(this.a, {super.key, this.compact = false});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final elsewhere = a['body'] != null && a['body'] != api.body;
    final buttons = Row(mainAxisAlignment: MainAxisAlignment.end, children: [
      TextButton(onPressed: () => act(context, () => api.call('decide', {'id': a['id'], 'approve': false})), child: const Text('拒绝')),
      FilledButton(onPressed: () => act(context, () => api.call('decide', {'id': a['id'], 'approve': true})), child: const Text('批准')),
    ]);
    if (compact) {
      return Padding(padding: const EdgeInsets.only(bottom: 4), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${a['action']}${elsewhere ? ' · ${a['body']}' : ''}', style: t.titleSmall),
        Text(plainPreview('${a['reason']}'), maxLines: 3, overflow: TextOverflow.ellipsis, style: t.bodySmall),
        buttons,
      ]));
    }
    return Section('${a['action']}', trailing: elsewhere ? Text('${a['body']}', style: t.bodySmall) : null, [
      RichMarkdown('${a['reason']}'),
      ExpansionTile(tilePadding: EdgeInsets.zero, title: Text('参数', style: t.labelLarge), children: [
        Align(alignment: Alignment.centerLeft, child: SelectableText(_json(a['args']), style: t.bodySmall?.copyWith(fontFamily: 'monospace'))),
      ]),
      buttons,
    ]);
  }
}

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
        title: '权限',
        body: ListenableBuilder(listenable: api, builder: (context, _) => ListView(padding: const EdgeInsets.only(bottom: 24), children: [
          for (final a in api.approvals) Padding(padding: const EdgeInsets.fromLTRB(12, 8, 12, 0), child: ApprovalCard(a as Map)),
          for (final p in perms)
            ListTile(
              title: Text('${p['label']}'),
              trailing: SegmentedButton<String>(
                showSelectedIcon: false,
                segments: const [ButtonSegment(value: 'allow', label: Text('允许')), ButtonSegment(value: 'ask', label: Text('询问')), ButtonSegment(value: 'deny', label: Text('禁止'))],
                selected: {p['level'] as String},
                onSelectionChanged: (v) async { await act(context, () => api.call('setPermission', {'id': p['id'], 'level': v.first})); _load(); },
              ),
            ),
        ])),
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
        Section('今天', [
          Text('${b['usage']['tokens']} / ${b['dailyTokens']} tokens'),
          LinearProgressIndicator(value: ((b['usage']['tokens'] as num) / (b['dailyTokens'] as num)).clamp(0, 1).toDouble()),
          const SizedBox(height: 8),
          Text('\$${(b['usage']['cost'] as num).toStringAsFixed(3)} / \$${b['dailyCostUsd']}'),
        ]),
        Section('每日上限', [
          for (final e in {'dailyTokens': 'tokens', 'dailyCostUsd': '花费（美元，0 不限）', 'minBattery': '最低电量 %', 'maxTempC': '最高温度 °C'}.entries)
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

// ---------------------------------------------------------------- 操作记录（审计）
String _actor(Object? a) => a == 'agent' ? api.name : '$a';

class AuditPage extends StatelessWidget {
  const AuditPage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '操作记录',
        body: FutureBuilder<List>(
          future: api.call<List>('audit', {'limit': 200}),
          builder: (_, s) => !s.hasData
              ? Center(child: s.hasError ? Text('${s.error}') : const CircularProgressIndicator())
              : ListView(children: [
                  for (final a in s.data!)
                    ListTile(
                      dense: true,
                      title: Text('${_actor(a['actor'])} · ${a['action']}'),
                      subtitle: Text('${hm(a['ts'])}  ${plainPreview('${a['result'] ?? ''}')}', maxLines: 2, overflow: TextOverflow.ellipsis),
                      onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => _AuditDetail(a as Map))),
                    ),
                ]),
        ),
      );
}

/// 一条记录的完整内容：参数（JSON）与输出（像 Markdown 就按 Markdown 渲染，否则原样等宽）。
class _AuditDetail extends StatelessWidget {
  final Map a;
  const _AuditDetail(this.a);
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return PageFrame(
      title: '${_actor(a['actor'])} · ${a['action']}',
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
/// 你通过保密输入（她调用 pass_secret 时）交给她的值：只列名字与说明，任何地方都不显示内容；可以删除。只在这具身体上，不同步。
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
        if (list.isEmpty) Padding(padding: const EdgeInsets.all(32), child: Text('空的。${api.name} 需要密码时会在对话里向你要。', textAlign: TextAlign.center)),
        for (final s in list.cast<Map>())
          ListTile(
            leading: const Icon(Icons.key),
            title: Text('${s['name']}'),
            subtitle: Text('${'${s['hint']}'.isEmpty ? '' : '${s['hint']}\n'}${hm(s['ts'])}'),
            isThreeLine: '${s['hint']}'.isNotEmpty,
            trailing: IconButton(tooltip: '删除', icon: const Icon(Icons.delete_outline), onPressed: () async {
              if (!await confirm(context, '删除「${s['name']}」', '之后需要时，她得再向你要一次。') || !context.mounted) return;
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
      if (e.name == 'feishu.registered') { setState(() => qr = null); toast(context, '已连接'); _load(); }
      if (e.name == 'feishu.error') setState(() { qr = null; error = '${(e.data as Map)['message']}'; });
    });
  }
  Future<void> _load() async { final r = await act(context, () => api.call<Map>('feishu.status')); if (mounted && r != null) setState(() => st = r); }

  @override
  Widget build(BuildContext context) {
    final st = this.st;
    final t = Theme.of(context).textTheme;
    final linked = st != null && st['appId'] != '';
    return PageFrame(
      title: '飞书',
      body: st == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        if (linked) Card(child: Column(children: [
          SwitchListTile(
            secondary: Icon(st['connected'] == true ? Icons.check_circle : Icons.cancel, color: st['connected'] == true ? Colors.green : Colors.grey),
            title: Text(st['connected'] == true ? '已连接' : '未连接'),
            subtitle: '${st['error']}'.isNotEmpty ? Text('${st['error']}') : null,
            value: st['enabled'] == true, onChanged: (v) async { await act(context, () => api.call('feishu.set', {'enabled': v})); _load(); },
          ),
          if (st['owner'] != true) ListTile(title: const Text('在飞书里给机器人发'), subtitle: SelectableText('${st['bindCode']}', style: t.titleMedium?.copyWith(fontFamily: 'monospace', letterSpacing: 2))),
        ])),
        if (!linked) Section('在飞书里和${api.name}说话', [
          if (qr == null) FilledButton.icon(icon: const Icon(Icons.qr_code), label: const Text('连接飞书'), onPressed: () { setState(() => error = null); act(context, () => api.call('feishu.register')); }),
          if (qr != null) ...[
            FilledButton.icon(icon: const Icon(Icons.open_in_new), label: const Text('在飞书中打开'), onPressed: () => openExternal(context, qr!)),
            const SizedBox(height: 12),
            Center(child: Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: qr!, size: 200))),
            const SizedBox(height: 4),
            Center(child: Text('或用飞书扫码', style: t.bodySmall)),
          ],
          if (error != null) Text(error!, style: const TextStyle(color: Colors.red)),
        ]),
        if (api.peers.isNotEmpty || '${st['holder'] ?? ''}'.isNotEmpty) Section('由哪台设备连接', [
          DropdownButton<String>(
            isExpanded: true,
            value: '${st['holder'] ?? ''}',
            items: [
              const DropdownMenuItem(value: '', child: Text('自动')),
              for (final b in {api.body, ...api.peers.map((p) => '${p['body']}'), if ('${st['holder'] ?? ''}'.isNotEmpty) '${st['holder']}'}) DropdownMenuItem(value: b, child: Text(b == api.body ? '$b（这台）' : b)),
            ],
            onChanged: (v) async { await act(context, () => api.call('feishu.setHolder', {'body': v ?? ''}), ok: '已保存'); _load(); },
          ),
        ]),
        ExpansionTile(title: Text('手动填写', style: t.bodyMedium), children: [
          TextField(controller: appId, decoration: const InputDecoration(labelText: 'App ID')),
          TextField(controller: secret, obscureText: true, decoration: const InputDecoration(labelText: 'App Secret')),
          TextButton(onPressed: () async { await act(context, () => api.call('feishu.set', {'appId': appId.text.trim(), 'appSecret': secret.text.trim(), 'enabled': true}), ok: '已保存'); _load(); }, child: const Text('连接')),
        ]),
      ]),
    );
  }
}

// ---------------------------------------------------------------- 同步（高级）
/// 灵魂仓库与同步服务的手动设置。绑定设备（「设备」页）时这些都自动配好，只有自己部署或接入特殊仓库时才来这里。
class SoulPage extends StatefulWidget {
  const SoulPage({super.key});
  @override
  State<SoulPage> createState() => _SoulPageState();
}

class _SoulPageState extends State<SoulPage> {
  Map? cfg;
  String? pub;
  String mode = 'deploy'; // 访问方式：deploy 本机部署密钥 / custom 指定私钥 / system 系统 ssh 配置
  final remote = TextEditingController(), keyPath = TextEditingController(), server = TextEditingController();
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final both = await act(context, () => Future.wait([api.call<Map>('soulConfig'), api.call<Map>('mesh')]));
    if (!mounted || both == null) return;
    final r = both[0], m = both[1];
    api.status['mesh'] = m;
    setState(() { cfg = r; remote.text = '${r['remote']}'; mode = '${r['sshMode'] ?? 'deploy'}'; keyPath.text = '${r['sshKeyPath'] ?? ''}'; server.text = '${m['server'] ?? ''}'; });
  }
  Future<void> _connect() async {
    await act(context, () => api.call('setSoulConfig', {'remote': remote.text.trim(), 'sshMode': mode, 'sshKeyPath': keyPath.text.trim()}), ok: '已保存');
    _load();
  }
  @override
  Widget build(BuildContext context) {
    final cfg = this.cfg;
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final muted = t.bodySmall?.copyWith(color: cs.onSurfaceVariant);
    return PageFrame(
      title: '同步',
      body: cfg == null ? const Center(child: CircularProgressIndicator()) : ListenableBuilder(listenable: api, builder: (context, _) {
        // 本机状态跟着 status.soul / status.mesh 实时刷新（后台的同步也会更新这里）
        final st = (api.status['soul'] as Map?) ?? (cfg['status'] as Map?) ?? {};
        final m = (api.status['mesh'] as Map?) ?? {};
        String when(Object? ms) => ms is num && ms > 0 ? hm(ms) : '从未';
        return ListView(padding: const EdgeInsets.all(12), children: [
          Section('记忆', trailing: FilledButton.tonal(onPressed: () async { await act(context, () => api.call('syncSoul'), ok: '已同步'); _load(); }, child: const Text('立即同步')), [
            Text('拉取 ${when(st['lastPull'])} · 推送 ${when(st['lastPush'])}', style: muted),
            if ('${st['lastError'] ?? ''}'.isNotEmpty) Text('${st['lastError']}', style: TextStyle(color: cs.error)),
          ]),
          Section('灵魂仓库', [
            TextField(controller: remote, decoration: const InputDecoration(labelText: '地址', hintText: 'git@github.com:<用户名>/<agent>.soul.git', border: OutlineInputBorder())),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              showSelectedIcon: false,
              segments: const [ButtonSegment(value: 'deploy', label: Text('部署密钥')), ButtonSegment(value: 'custom', label: Text('指定私钥')), ButtonSegment(value: 'system', label: Text('系统 ssh'))],
              selected: {mode},
              onSelectionChanged: (v) => setState(() => mode = v.first),
            ),
            const SizedBox(height: 8),
            if (mode == 'deploy') ...[
              Text('加到仓库的 Deploy keys，允许写入', style: muted),
              if (pub != null) SelectableText(pub!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
              if (pub == null) Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () async { final k = await act(context, () => api.call<String>('soulKey')); if (mounted) setState(() => pub = k); }, child: const Text('显示公钥'))),
            ],
            if (mode == 'custom') TextField(controller: keyPath, decoration: const InputDecoration(labelText: '私钥路径', hintText: '~/.ssh/id_ed25519', border: OutlineInputBorder())),
            if (mode == 'system') Text('使用这台机器的 ~/.ssh/config', style: muted),
            const SizedBox(height: 8),
            Align(alignment: Alignment.centerLeft, child: FilledButton(onPressed: _connect, child: const Text('保存'))),
          ]),
          Section('同步服务', [
            TextField(controller: server, decoration: const InputDecoration(labelText: '地址', hintText: '留空用官方', border: OutlineInputBorder())),
            const SizedBox(height: 8),
            Row(children: [
              FilledButton.tonal(onPressed: () async { await act(context, () => api.call('mesh.setServer', {'server': server.text.trim()}), ok: '已保存'); _load(); }, child: const Text('保存')),
              const SizedBox(width: 12),
              Expanded(child: Text(meshStateLabel['${m['state']}'] ?? '${m['state'] ?? ''}', style: muted)),
            ]),
            if ('${m['error'] ?? ''}'.isNotEmpty) Text('${m['error']}', style: TextStyle(color: cs.error)),
          ]),
          if (m['bound'] == true) Section('优先负责心跳', [
            Text('几台设备都在线时，数值大的负责心跳', style: muted),
            _PriorityField(initial: (m['priority'] as num?)?.toInt() ?? 0),
          ]),
          Section('Hermes / OpenClaw', [
            Text('把这句话发给它，它会自己接入', style: muted),
            const SizedBox(height: 4),
            SelectableText(_bridgePrompt(remote.text.trim()), style: t.bodySmall),
            Align(alignment: Alignment.centerLeft, child: TextButton.icon(icon: const Icon(Icons.copy, size: 18), label: const Text('复制'), onPressed: () { Clipboard.setData(ClipboardData(text: _bridgePrompt(remote.text.trim()))); toast(context, '已复制'); })),
          ]),
        ]);
      }),
    );
  }
}

class _PriorityField extends StatefulWidget {
  final int initial;
  const _PriorityField({required this.initial});
  @override
  State<_PriorityField> createState() => _PriorityFieldState();
}

class _PriorityFieldState extends State<_PriorityField> {
  late double v = widget.initial.clamp(0, 10).toDouble();
  @override
  Widget build(BuildContext context) => Row(children: [
        Expanded(child: Slider(value: v, min: 0, max: 10, divisions: 10, label: '${v.round()}', onChanged: (x) => setState(() => v = x),
            onChangeEnd: (x) => act(context, () => api.call('mesh.setPriority', {'priority': x.round()}), ok: '已保存'))),
        Text('${v.round()}'),
      ]);
}

String _bridgePrompt(String repo) =>
    '请安装 soul-bridge 技能（https://github.com/PlutoKeating/Project.Quetzal/tree/main/bridge/skills/soul-bridge），'
    '按技能说明把你接入灵魂仓库 ${repo.isEmpty ? '<仓库地址>' : repo}，需要我配合的步骤告诉我。';

// ---------------------------------------------------------------- 运行（高级）
/// 命令执行的沙箱（status.sandbox：kind 为 bwrap | landlock | proot | none；旧版运行基座没有这一项，不显示）。
/// none 时她的命令缺省一律不执行；这里可以明确允许不隔离运行（不安全，要二次确认）。
List<Widget> sandboxLines(BuildContext context, Map sb) {
  final kind = '${sb['kind']}', allow = sb['allowUnsandboxed'] == true;
  final err = TextStyle(color: Theme.of(context).colorScheme.error);
  return [
    _kv(context, '沙箱', switch (kind) { 'bwrap' => 'bubblewrap', 'landlock' => 'Landlock', 'proot' => 'proot', 'none' => '无', _ => kind }),
    if (kind == 'none') ...[
      Text(allow ? '命令不经隔离直接运行，能读到所有密钥。' : '没有沙箱，她的命令不会执行。重新安装一次即可补上。', style: err),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('不隔离也运行（不安全）'),
        value: allow,
        onChanged: (v) async {
          if (v && !(await confirm(context, '不隔离也运行', '她执行的命令将能读到模型 Key、令牌与私钥，也能改动这个用户的任何文件。确定吗？'))) return;
          if (context.mounted) await act(context, () => api.call('sandbox.allowUnsandboxed', {'allow': v}), ok: v ? '已允许' : '已关闭');
        },
      ),
    ],
  ];
}

Widget _kv(BuildContext context, String k, String v) {
  final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
  return Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
    SizedBox(width: 72, child: Text(k, style: t.bodyMedium?.copyWith(color: cs.onSurfaceVariant))),
    Expanded(child: Text(v)),
  ]));
}

class ServicePage extends StatelessWidget {
  const ServicePage({super.key});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '运行',
        body: ListenableBuilder(listenable: api, builder: (context, _) {
          final s = api.status, p = api.physical, sys = (p['system'] as Map?) ?? {};
          return ListView(padding: const EdgeInsets.all(12), children: [
            Section('状态', [
              _kv(context, '连接', '${switch (api.conn) { Conn.online => '在线', Conn.igniting => '启动中', Conn.connecting => '连接中', _ => '离线' }}${api.safeMode ? ' · 安全模式' : ''}'),
              _kv(context, '版本', '${s['version'] ?? '-'}'),
              _kv(context, '设备', '${s['body'] ?? '-'} · ${s['adapter'] ?? '-'}'),
              if (s['sandbox'] is Map && (s['sandbox'] as Map)['kind'] is String) ...sandboxLines(context, s['sandbox'] as Map),
              _kv(context, '系统', '运行 ${sys['uptimeH'] ?? '-'} 小时 · 负载 ${sys['load1'] ?? '-'} · 内存 ${sys['memFreeMB'] ?? '-'} MB · 存储 ${sys['storageFreeGB'] ?? '-'} GB'),
            ]),
            const _SupervisionSection(),
            Section('操作', [
              Wrap(spacing: 8, runSpacing: 8, children: [
                FilledButton.tonal(onPressed: () async { if (await confirm(context, '重启', '约 5 秒后恢复。') && context.mounted) await act(context, () => api.call('restart'), ok: '正在重启'); }, child: const Text('重启')),
                if (hasBody) FilledButton.tonal(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage(upgrade: true))), child: const Text('重装')),
                OutlinedButton(onPressed: () async {
                  if (await confirm(context, '重新配对', '这台设备上的控制台需要重新配对。')) await api.saveSettings(token: '');
                }, child: const Text('重新配对')),
              ]),
            ]),
          ]);
        }),
      );
}

/// 守护开关：开机自启 + 退出后自动重启，一个开关管两件事。由身体适配器实现（Linux：systemd 用户服务或守护循环；安卓：Quetzal App 的前台服务与开机广播）；没有守护者的身体不显示。
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
    return Card(child: SwitchListTile(
      title: const Text('开机自启，退出后自动重启'),
      subtitle: on ? null : const Text('已关闭：退出后不会再醒来'),
      value: on,
      onChanged: busy ? null : (v) async {
        setState(() => busy = true);
        final r = await act(context, () => api.call<Map>('setSupervision', {'enabled': v}), ok: v ? '已开启' : '已关闭');
        if (mounted) setState(() { busy = false; if (r != null) st = r; });
      },
    ));
  }
}
