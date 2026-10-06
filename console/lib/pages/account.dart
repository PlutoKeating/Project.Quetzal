// 账户：管理同步服务上的整个账户（与官网的账户页同一套接口）：agent 与设备、添加设备、登录过的控制台、账户设置。从「设备」页进入。
// 这台设备先要登录（「设备」页的设备码绑定）；同一次批准通常已顺带拿到「控制台登录」，运行基座代这个 App 持有账户令牌；旧的同步服务不给时这里再登录一次。
// 状态来自网关的 account 方法与 account 事件；账户数据每次进入分页时读取。
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';
import 'mesh.dart';
import '../links.dart';

const _kind = {'runtime': 'Quetzal', 'bridge': '灵魂桥', 'console': '控制台'};
const _errors = {
  'bad_code': '码不对或已过期',
  'expired': '码已过期，请在那台设备上重来',
  'decided': '这个码已经用过了',
  'too_many_agents': 'agent 数量已达上限',
  'too_many_bodies': '设备数量已达上限，先移除不用的',
  'not_yours': '那台设备不在你的账户下',
  'too_many': '输错太多次，稍后再试',
  'not_found': '没有找到',
};
String _err(Object e) {
  final s = '$e'.replaceFirst(RegExp(r'^(Exception|Error):\s*'), '');
  return _errors[s] ?? s;
}

String _ago(dynamic ms) {
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch((ms as num?)?.toInt() ?? 0));
  if (d.inMinutes < 1) return '刚刚';
  if (d.inHours < 1) return '${d.inMinutes} 分钟前';
  if (d.inDays < 1) return '${d.inHours} 小时前';
  return '${d.inDays} 天前';
}

class AccountPage extends StatefulWidget {
  const AccountPage({super.key});
  @override
  State<AccountPage> createState() => _AccountPageState();
}

class _AccountPageState extends State<AccountPage> {
  Map? acct;
  @override
  void initState() {
    super.initState();
    api.addListener(_onEvent);
    _load();
  }
  @override
  void dispose() { api.removeListener(_onEvent); super.dispose(); }
  void _onEvent() { final a = api.status['account']; if (a is Map && mounted && a != acct) setState(() => acct = a); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('account'));
    if (!mounted || r == null) return;
    api.status['account'] = r;
    setState(() => acct = r);
  }

  @override
  Widget build(BuildContext context) {
    final a = acct;
    if (a == null) return const PageFrame(title: '账户', body: Center(child: CircularProgressIndicator()));
    if (a['bound'] != true) return const PageFrame(title: '账户', body: Center(child: Text('这台设备还没有登录')));
    if (a['signedIn'] != true) return PageFrame(title: '账户', body: _SignIn(a: a));
    return DefaultTabController(
      length: 4,
      child: PageFrame(
        title: '账户 · ${a['account']}',
        body: Column(children: const [
          TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [Tab(text: '概览'), Tab(text: '添加设备'), Tab(text: '已登录'), Tab(text: '设置')]),
          Expanded(child: TabBarView(children: [_Overview(), _Approve(), _Consoles(), _Settings()])),
        ]),
      ),
    );
  }
}

class _SignIn extends StatelessWidget {
  final Map a;
  const _SignIn({required this.a});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final s = a['signing'] as Map?;
    return ListView(padding: const EdgeInsets.all(12), children: [
      Section('管理账户', [
        Text('${a['account']}', style: t.bodySmall),
        if ('${a['error'] ?? ''}'.isNotEmpty) Text('${a['error']}', style: const TextStyle(color: Colors.red)),
        const SizedBox(height: 8),
        if (s == null) FilledButton(onPressed: () async {
          final r = await act(context, () => api.call<Map>('account.signIn'));
          final uri = (r?['signing'] as Map?)?['uri'];
          if (uri is String && context.mounted) await openExternal(context, uri);
        }, child: const Text('登录')),
        if (s != null) DeviceCodeView(pending: s, onCancel: () => act(context, () => api.call('account.cancel'))),
      ]),
    ]);
  }
}

class _Overview extends StatefulWidget {
  const _Overview();
  @override
  State<_Overview> createState() => _OverviewState();
}

class _OverviewState extends State<_Overview> {
  Future<Map>? f;
  @override
  void initState() { super.initState(); f = api.call<Map>('account.get'); }
  void _reload() => setState(() => f = api.call<Map>('account.get'));

  @override
  Widget build(BuildContext context) => FutureBuilder<Map>(future: f, builder: (context, snap) {
        if (snap.hasError) return _ErrorView(error: snap.error!, onRetry: _reload);
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final d = snap.data!;
        final agents = ((d['agents'] as List?) ?? []).cast<Map>();
        final limits = (d['limits'] as Map?) ?? {};
        return RefreshIndicator(onRefresh: () async => _reload(), child: ListView(padding: const EdgeInsets.all(12), children: [
          Padding(padding: const EdgeInsets.all(4), child: Text('${agents.length} / ${limits['agents'] ?? '-'} 个 agent · 每个最多 ${limits['bodies'] ?? '-'} 台设备', style: Theme.of(context).textTheme.bodySmall)),
          if (agents.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('还没有 agent', textAlign: TextAlign.center)),
          for (final a in agents) Section('${a['name']}', [
            for (final b in ((a['bodies'] as List?) ?? []).cast<Map>()) ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.circle, size: 12, color: b['online'] == true ? Colors.orange : Colors.grey),
              title: Text('${b['body']}${b['body'] == api.status['body'] ? '（这台）' : ''}'),
              subtitle: Text([
                _kind['${b['kind']}'] ?? '${b['kind']}',
                if ('${b['version'] ?? ''}'.isNotEmpty) '${b['version']}',
                b['online'] == true ? '在线' : _ago(b['lastSeen']),
              ].join(' · ')),
              trailing: TextButton(onPressed: () async {
                if (await confirm(context, '移除 ${b['body']}', '它会立刻断开，要重新登录才能再连上。') && context.mounted) {
                  await act(context, () => api.call('account.removeBody', {'agent': a['id'], 'body': b['body']}), ok: '已移除');
                  _reload();
                }
              }, child: const Text('移除', style: TextStyle(color: Colors.red))),
            ),
            Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () async {
              if (await confirm(context, '删除 ${a['name']}', 'ta 的所有设备都会断开。灵魂仓库与设备上的数据不受影响。') && context.mounted) {
                await act(context, () => api.call('account.removeAgent', {'agent': a['id']}), ok: '已删除');
                _reload();
              }
            }, child: const Text('删除', style: TextStyle(color: Colors.red)))),
          ]),
        ]));
      });
}

class _Approve extends StatefulWidget {
  const _Approve();
  @override
  State<_Approve> createState() => _ApproveState();
}

class _ApproveState extends State<_Approve> {
  final code = TextEditingController();
  Map? pending;
  String? done, error, agent;
  bool busy = false;

  Future<void> _lookup() async {
    setState(() { busy = true; error = null; });
    try { final p = await api.call<Map>('account.lookup', {'code': code.text.trim()}); setState(() { pending = p; agent = null; }); }
    catch (e) { setState(() => error = _err(e)); }
    finally { if (mounted) setState(() => busy = false); }
  }
  Future<void> _decide(bool approve) async {
    setState(() { busy = true; error = null; });
    try {
      final choose = (pending!['choose'] as List?)?.cast<Map>();
      final pick = choose == null ? null : (choose.isEmpty ? 'new' : agent ?? '${choose.first['id']}');
      final r = await api.call<Map>('account.decide', {'code': pending!['code'], 'approve': approve, 'agent': ?pick});
      final next = r['next'];
      // 还要把部署密钥加到灵魂仓库：在浏览器里经 GitHub 跳一次就回来（第一次要在 GitHub 上授权并选中灵魂仓库）
      if (approve && next is String && next.startsWith('https://') && mounted) await openExternal(context, next);
      setState(() { done = approve ? '已添加 ${pending!['body']}' : '已拒绝'; pending = null; code.clear(); });
    } catch (e) { setState(() => error = _err(e)); }
    finally { if (mounted) setState(() => busy = false); }
  }

  @override
  Widget build(BuildContext context) {
    final p = pending;
    return ListView(padding: const EdgeInsets.all(12), children: [
      if (p == null) Section('输入新设备上显示的码', [
        TextField(controller: code, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(hintText: 'XXXX-XXXX', border: OutlineInputBorder()), onSubmitted: (_) => _lookup()),
        const SizedBox(height: 8),
        FilledButton(onPressed: busy ? null : _lookup, child: const Text('下一步')),
        if (done != null) Text(done!),
      ]),
      if (p != null) Section('${p['body']}', [
        if ('${p['check'] ?? ''}'.isNotEmpty) ...[
          Text('${p['check']}', style: const TextStyle(fontSize: 36, letterSpacing: 6)),
          const Text('和那台设备上的表情一样才批准', style: TextStyle(fontSize: 12)),
          const SizedBox(height: 8),
        ],
        if (p['choose'] == null) Text('${(p['agent'] as Map?)?['name']}'),
        if (p['choose'] is List && (p['choose'] as List).isNotEmpty) ...[
          const Text('加入'),
          RadioGroup<String>(
            groupValue: agent ?? '${((p['choose'] as List).first as Map)['id']}',
            onChanged: (v) => setState(() => agent = v),
            child: Column(children: [
              for (final x in [...((p['choose'] as List).cast<Map>().map((m) => MapEntry('${m['id']}', '${m['name']}${'${m['repo'] ?? ''}'.isNotEmpty ? ' · ${m['repo']}' : ''}'))), MapEntry('new', '新的 agent')])
                RadioListTile<String>(dense: true, contentPadding: EdgeInsets.zero, value: x.key, title: Text(x.value)),
            ]),
          ),
        ],
        Text([_kind['${p['kind']}'] ?? '${p['kind']}', if ('${p['version'] ?? ''}'.isNotEmpty) '${p['version']}'].join(' '), style: const TextStyle(fontSize: 12)),
        if (p['kind'] != 'console' && '${p['check'] ?? ''}'.isEmpty) Text('指纹 ${p['fingerprint']}（和那台设备上的一样才批准）', style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
        if (p['kind'] == 'console') const Text('它将能管理你的整个账户', style: TextStyle(color: Colors.orange)),
        if (p['replaces'] == true) const Text('它之前的登录会失效', style: TextStyle(color: Colors.orange)),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          FilledButton(onPressed: busy ? null : () => _decide(true), child: const Text('批准')),
          OutlinedButton(onPressed: busy ? null : () => _decide(false), child: const Text('拒绝', style: TextStyle(color: Colors.red))),
          TextButton(onPressed: busy ? null : () => setState(() => pending = null), child: const Text('返回')),
        ]),
      ]),
      if (error != null) Padding(padding: const EdgeInsets.all(4), child: Text(error!, style: const TextStyle(color: Colors.red))),
    ]);
  }
}

class _Consoles extends StatefulWidget {
  const _Consoles();
  @override
  State<_Consoles> createState() => _ConsolesState();
}

class _ConsolesState extends State<_Consoles> {
  Future<Map>? f;
  @override
  void initState() { super.initState(); f = api.call<Map>('account.get'); }
  void _reload() => setState(() => f = api.call<Map>('account.get'));
  @override
  Widget build(BuildContext context) => FutureBuilder<Map>(future: f, builder: (context, snap) {
        if (snap.hasError) return _ErrorView(error: snap.error!, onRetry: _reload);
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final list = ((snap.data!['consoles'] as List?) ?? []).cast<Map>();
        return ListView(padding: const EdgeInsets.all(12), children: [
          Section('登录过的控制台', [
            if (list.isEmpty) const Text('没有'),
            for (final c in list) ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${c['body']}${c['current'] == true ? '（这里）' : ''}'),
              subtitle: Text('最近使用 ${_ago(c['lastUsed'])}'),
              trailing: TextButton(onPressed: () async {
                final self = c['current'] == true;
                if (await confirm(context, '退出', self ? '退出后要重新登录才能管理账户。' : '那台设备将不能再管理账户。') && context.mounted) {
                  await act(context, () => api.call('account.revokeConsole', {'id': c['id']}), ok: '已退出');
                  if (self) { await api.call('account').then((r) => api.status['account'] = r).catchError((_) => null); }
                  _reload();
                }
              }, child: const Text('退出', style: TextStyle(color: Colors.red))),
            ),
          ]),
        ]);
      });
}

class _Settings extends StatelessWidget {
  const _Settings();
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(12), children: [
        Card(child: Column(children: [
          ListTile(title: const Text('退出管理'), subtitle: const Text('设备照常连接'), onTap: () => act(context, () => api.call('account.signOut'), ok: '已退出')),
          ListTile(title: const Text('删除账户', style: TextStyle(color: Colors.red)), onTap: () async {
            if (await confirm(context, '删除账户', '所有 agent 与设备的登记都会删除，设备立即断开。灵魂仓库与设备上的数据不受影响。不能撤销。') && context.mounted) {
              await act(context, () => api.call('account.delete'), ok: '账户已删除');
            }
          }),
        ])),
      ]);
}

class _ErrorView extends StatelessWidget {
  final Object error;
  final VoidCallback onRetry;
  const _ErrorView({required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(12), children: [
        Text(_err(error), style: const TextStyle(color: Colors.red)), Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: onRetry, child: const Text('重试'))),
      ]);
}
