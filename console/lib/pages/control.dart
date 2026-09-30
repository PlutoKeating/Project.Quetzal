// 控制：日常调节 → 安全 → 连接与运维，越往下越偏技术。审批的理由按 Markdown 渲染；审计日志点开看完整参数与输出。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import 'providers.dart';
import 'agents.dart';

class ControlPage extends ApiWidget {
  const ControlPage({super.key});
  @override
  Widget view(BuildContext context) {
    void go(Widget w) => Navigator.push(context, MaterialPageRoute(builder: (_) => w));
    Widget item(IconData i, String t, String s, Widget page, {int badge = 0}) => ListTile(
          leading: Badge(isLabelVisible: badge > 0, label: Text('$badge'), child: Icon(i)),
          title: Text(t), subtitle: Text(s), trailing: const Icon(Icons.chevron_right), onTap: () => go(page));
    Widget header(String t) => Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 4), child: Text(t, style: Theme.of(context).textTheme.labelLarge));
    final s = api.status;
    return ListView(children: [
      header('身份'),
      item(Icons.badge, '身份', '${api.name} · 名字、代词、简介、主题色', const IdentityPage()),
      header('日常'),
      item(Icons.self_improvement, '自主性', '活跃度 ${s['activity'] ?? 1}× · ${s['paused'] == true ? '已暂停' : '进行中'}', const AutonomyPage()),
      item(Icons.gavel, '审批', '${api.approvals.length} 个待处理', const ApprovalsPage(), badge: api.approvals.length),
      header('安全'),
      item(Icons.verified_user, '能力授权', '她能做什么、需要问你什么', const PermissionsPage()),
      item(Icons.savings, '预算', '今日 ${(s['usage'] as Map?)?['tokens'] ?? 0} tokens', const BudgetPage()),
      item(Icons.receipt_long, '审计日志', '每一次动作与修改', const AuditPage()),
      header('连接'),
      item(Icons.hub, '模型', '${(s['models'] as List?)?.length ?? 0} 个可用模型 · 供应商、Key 与顺序', const ProvidersPage()),
      item(Icons.send, '飞书', '一键扫码接入，在飞书里和她说话', const FeishuPage()),
      item(Icons.record_voice_over, '语音', 'Azure 语音：她的声音、音色与风格（她自己也可以调）', const VoicePage()),
      item(Icons.cloud_sync, '灵魂同步', '与其他身体共享人格与记忆', const SoulPage()),
      item(Icons.history, '记忆历史', '每一次变更来自哪具身体，可查看与撤销', const HistoryPage()),
      header('运维'),
      item(Icons.monitor_heart, '服务', '版本 ${s['version'] ?? '-'} · 身体 ${s['body'] ?? '-'}（${s['adapter'] ?? '-'}）', const ServicePage()),
    ]);
  }
}

// ---------------------------------------------------------------- 自主性
class AutonomyPage extends StatelessWidget {
  const AutonomyPage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('自主性')),
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
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('审批')),
        body: ListenableBuilder(listenable: api, builder: (context, _) => ListView(children: [
          if (api.approvals.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('没有待处理的请求', textAlign: TextAlign.center)),
          for (final a in api.approvals)
            Section('${a['action']}', [
              Text('理由', style: Theme.of(context).textTheme.labelLarge),
              RichMarkdown('${a['reason']}'),
              const SizedBox(height: 6),
              Text('参数', style: Theme.of(context).textTheme.labelLarge),
              SelectableText(_json(a['args']), style: Theme.of(context).textTheme.bodySmall?.copyWith(fontFamily: 'monospace')),
              Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                TextButton(onPressed: () => act(context, () => api.call('decide', {'id': a['id'], 'approve': false})), child: const Text('拒绝')),
                FilledButton(onPressed: () => act(context, () => api.call('decide', {'id': a['id'], 'approve': true})), child: const Text('批准')),
              ]),
            ]),
        ])),
      );
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
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('能力授权')),
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
    return Scaffold(
      appBar: AppBar(title: const Text('预算')),
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
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('审计日志')),
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
    return Scaffold(
      appBar: AppBar(title: Text('${a['actor']} · ${a['action']}')),
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
    return Scaffold(
      appBar: AppBar(title: const Text('飞书')),
      body: st == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        Section('状态', [
          ListTile(contentPadding: EdgeInsets.zero, leading: Icon(st['connected'] == true ? Icons.check_circle : Icons.cancel, color: st['connected'] == true ? Colors.green : Colors.grey),
              title: Text(st['connected'] == true ? '已连接' : st['appId'] == '' ? '尚未接入' : '未连接'),
              subtitle: Text('${st['appId'] == '' ? '' : 'App ID：${st['appId']}　'}${st['owner'] == true ? '已绑定你' : '未绑定'}${st['error'] != '' ? '\n${st['error']}' : ''}')),
          if (st['appId'] != '') SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('启用'), value: st['enabled'] == true, onChanged: (v) async { await act(context, () => api.call('feishu.set', {'enabled': v})); _load(); }),
          if (st['appId'] != '' && st['owner'] != true) Text('绑定：在飞书里给机器人发送绑定码 ${st['bindCode']}'),
        ]),
        Section('一键接入（推荐）', [
          Text('自动创建一个名为「${api.name}」的飞书机器人，权限、事件与卡片回调都会预先配置好；确认后自动绑定你本人。'),
          const SizedBox(height: 8),
          if (qr == null) FilledButton.icon(icon: const Icon(Icons.qr_code), label: const Text('开始'), onPressed: () { setState(() => error = null); act(context, () => api.call('feishu.register')); }),
          if (qr != null) ...[
            FilledButton.icon(icon: const Icon(Icons.open_in_new), label: const Text('在飞书中打开并确认'), onPressed: () => launchUrl(Uri.parse(qr!), mode: LaunchMode.externalApplication)),
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
  final remote = TextEditingController();
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('soulConfig'));
    if (mounted && r != null) setState(() { cfg = r; remote.text = '${r['remote']}'; });
  }
  @override
  Widget build(BuildContext context) {
    final cfg = this.cfg, st = (cfg?['status'] as Map?) ?? {};
    return Scaffold(
      appBar: AppBar(title: const Text('灵魂同步')),
      body: cfg == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        const Padding(padding: EdgeInsets.all(4), child: Text('她可以同时住在多具身体里（例如另一台运行 Hermes 的设备）。所有身体共享一个私有 git 仓库：人格、常驻记忆、笔记与日记。每次醒来前拉取，醒来后推送。')),
        Section('本机', [
          Text('身体名称：${cfg['body']}'),
          Text('上次拉取：${(st['lastPull'] ?? 0) == 0 ? '从未' : hm(st['lastPull'])}　上次推送：${(st['lastPush'] ?? 0) == 0 ? '从未' : hm(st['lastPush'])}'),
          if ('${st['lastError'] ?? ''}'.isNotEmpty) Text('${st['lastError']}', style: const TextStyle(color: Colors.red)),
          FilledButton.tonal(onPressed: () async { await act(context, () => api.call('syncSoul'), ok: '已同步'); _load(); }, child: const Text('立即同步')),
        ]),
        Section('1. 本机的访问密钥', [
          const Text('把下面的公钥添加到灵魂仓库网页的「Deploy keys」，并勾选「允许写入」。'),
          if (pub != null) SelectableText(pub!, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
          TextButton(onPressed: () async { final k = await act(context, () => api.call<String>('soulKey')); if (mounted) setState(() => pub = k); }, child: Text(pub == null ? '显示公钥' : '已生成')),
        ]),
        Section('2. 灵魂仓库地址', [
          TextField(controller: remote, decoration: const InputDecoration(labelText: '例如 git@github.com:你的用户名/<agent>.soul.git', border: OutlineInputBorder())),
          const SizedBox(height: 8),
          FilledButton(onPressed: () async { await act(context, () => api.call('setSoulConfig', {'remote': remote.text.trim()}), ok: '已接入'); _load(); }, child: const Text('接入')),
          const Text('仓库必须是私有的。首次接入时，若仓库里已有另一具身体的人格，会直接采用它，并合并两边的记忆。', style: TextStyle(fontSize: 12)),
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
class ServicePage extends StatelessWidget {
  const ServicePage({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('服务')),
        body: ListenableBuilder(listenable: api, builder: (context, _) {
          final s = api.status, p = api.physical, sys = (p['system'] as Map?) ?? {};
          return ListView(children: [
            Section('运行状态', [
              Text('连接：${api.conn.name}${api.safeMode ? '（安全模式）' : ''}'),
              Text('版本：${s['version'] ?? '-'}'),
              Text('身体：${s['body'] ?? '-'} · 适配器 ${s['adapter'] ?? '-'}'),
              Text('系统：已运行 ${sys['uptimeH'] ?? '-'} 小时 · 负载 ${sys['load1'] ?? '-'} · 空闲内存 ${sys['memFreeMB'] ?? '-'} MB · 存储余量 ${sys['storageFreeGB'] ?? '-'} GB'),
              Text('模型：${((s['models'] as List?) ?? []).join('、')}'),
            ]),
            Section('操作', [
              Wrap(spacing: 8, children: [
                FilledButton.tonal(onPressed: () async { final e = await api.ignite(); if (e != null && context.mounted) toast(context, e); }, child: const Text('点火')),
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

String _bridgePrompt(String repo) =>
    '请安装 soul-bridge 技能（https://github.com/PlutoKeating/Project.Windler/tree/main/bridge/skills/soul-bridge），'
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
    return Scaffold(
      appBar: AppBar(title: const Text('语音')),
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
