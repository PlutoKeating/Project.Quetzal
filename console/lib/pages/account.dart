// 账户：管理同步服务上的整个账户（与官网的账户页同一套接口）：agent 与身体、批准新的设备、控制台登录、账户设置。
// 这具身体先要绑定到同步服务（「多具身体」）；再做一次控制台登录：码在官网的「批准设备」页批准后，运行基座代这个 App 持有账户令牌。
// 状态来自网关的 account 方法与 account 事件；账户数据每次进入分页时读取。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../api.dart';
import '../widgets.dart';
import 'mesh.dart';
import '../links.dart';

const _kind = {'runtime': '运行基座', 'bridge': '灵魂桥（只读）', 'console': '控制台登录'};
const _errors = {
  'bad_code': '这个码不存在或已过期。',
  'expired': '码已过期，请在那具身体上重新开始。',
  'decided': '这个码已经处理过了。',
  'too_many_agents': '你的账户下 agent 数量已达上限。',
  'too_many_bodies': '这个 agent 的身体数量已达上限，先解绑不用的身体。',
  'not_yours': '发起请求的身体不在你的账户下，不能批准。',
  'too_many': '输错次数太多，请稍后再试。',
  'not_found': '没有找到，可能已经被删除。',
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
    if (a['bound'] != true) return PageFrame(title: '账户', body: _NotBound());
    if (a['signedIn'] != true) return PageFrame(title: '账户', body: _SignIn(a: a));
    return DefaultTabController(
      length: 4,
      child: PageFrame(
        title: '账户 · ${a['account']}',
        body: Column(children: const [
          TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [Tab(text: '概览'), Tab(text: '批准设备'), Tab(text: '控制台登录'), Tab(text: '账户设置')]),
          Expanded(child: TabBarView(children: [_Overview(), _Approve(), _Consoles(), _Settings()])),
        ]),
      ),
    );
  }
}

class _NotBound extends StatelessWidget {
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(12), children: [
        Section('先绑定这具身体', [
          const Text('账户由同步服务管理：用 GitHub 登录，同一个 agent 的身体都绑定在账户下。这具身体还没有绑定到同步服务，先在「多具身体」里点「绑定到同步服务」，然后回到这里登录账户。'),
          const SizedBox(height: 8),
          FilledButton.tonal(onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const MeshPage())), child: const Text('打开「多具身体」')),
        ]),
      ]);
}

class _SignIn extends StatelessWidget {
  final Map a;
  const _SignIn({required this.a});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final s = a['signing'] as Map?;
    return ListView(padding: const EdgeInsets.all(12), children: [
      Section('登录账户', [
        Text('这具身体已绑定到账户 ${a['account']}。要在这个 App 里管理整个账户（查看与解绑身体、批准新的设备、删除账户），需要你批准一次「控制台登录」。批准后可以随时在这里或官网的「控制台登录」里吊销。'),
        if ('${a['error'] ?? ''}'.isNotEmpty) Text('${a['error']}', style: const TextStyle(color: Colors.red)),
        const SizedBox(height: 8),
        if (s == null) FilledButton(onPressed: () => act(context, () => api.call('account.signIn')), child: const Text('登录账户')),
        if (s != null) ...[
          const Text('在浏览器里打开下面的链接（用 GitHub 登录），确认码一致后点「批准」。页面会提示这是「控制台登录」：只批准你自己刚刚在这里发起的。'),
          const SizedBox(height: 8),
          SelectableText('${s['code']}', style: t.headlineMedium?.copyWith(letterSpacing: 4, fontFamily: 'monospace')),
          Wrap(spacing: 8, children: [
            FilledButton.icon(icon: const Icon(Icons.open_in_new), label: const Text('打开链接'), onPressed: () => openExternal(context, '${s['uri']}')),
            TextButton.icon(icon: const Icon(Icons.copy), label: const Text('复制链接'), onPressed: () { Clipboard.setData(ClipboardData(text: '${s['uri']}')); toast(context, '已复制'); }),
            TextButton(onPressed: () => act(context, () => api.call('account.cancel')), child: const Text('取消')),
          ]),
          const Text('或者用另一台设备扫码：'),
          Center(child: Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: '${s['uri']}', size: 180))),
          const Text('等待批准中…（15 分钟内有效）'),
        ],
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
          Padding(padding: const EdgeInsets.all(4), child: Text('${agents.length} / ${limits['agents'] ?? '-'} 个 agent · 每个 agent 最多 ${limits['bodies'] ?? '-'} 具身体', style: Theme.of(context).textTheme.bodySmall)),
          if (agents.isEmpty) const Section('还没有 agent', [Text('在一具身体的「多具身体」里绑定同步服务，批准后就会出现在这里。')]),
          for (final a in agents) Section('${a['name']}', [
            SelectableText('${a['id']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            for (final b in ((a['bodies'] as List?) ?? []).cast<Map>()) ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.circle, size: 12, color: b['online'] == true ? Colors.orange : Colors.grey),
              title: Text('${b['body']}${b['body'] == api.status['body'] ? '（这具身体）' : ''}'),
              subtitle: Text([
                _kind['${b['kind']}'] ?? '${b['kind']}',
                if ('${b['version'] ?? ''}'.isNotEmpty) '${b['version']}',
                b['online'] == true ? '在线' : '最近在线 ${_ago(b['lastSeen'])}',
                '公钥 ${b['fingerprint']}',
              ].join(' · ')),
              trailing: TextButton(onPressed: () async {
                if (await confirm(context, '解绑 ${b['body']}', '它会立刻断开，要重新绑定才能再连上。确定吗？') && context.mounted) {
                  await act(context, () => api.call('account.removeBody', {'agent': a['id'], 'body': b['body']}), ok: '已解绑');
                  _reload();
                }
              }, child: const Text('解绑', style: TextStyle(color: Colors.red))),
            ),
            Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () async {
              if (await confirm(context, '删除 ${a['name']}', 'ta 的所有身体都会从账户里解绑并断开（灵魂仓库与各身体上的数据不受影响）。确定吗？') && context.mounted) {
                await act(context, () => api.call('account.removeAgent', {'agent': a['id']}), ok: '已删除');
                _reload();
              }
            }, child: const Text('删除这个 agent', style: TextStyle(color: Colors.red)))),
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
      setState(() { done = approve ? (next is String ? '已批准。浏览器里经 GitHub 确认一下，${pending!['body']} 就会接好灵魂仓库。' : '已批准。${pending!['body']} 几秒内就会完成。') : '已拒绝，这个码作废了。'; pending = null; code.clear(); });
    } catch (e) { setState(() => error = _err(e)); }
    finally { if (mounted) setState(() => busy = false); }
  }

  @override
  Widget build(BuildContext context) {
    final p = pending;
    return ListView(padding: const EdgeInsets.all(12), children: [
      if (p == null) Section('输入码', [
        const Text('另一具身体在绑定时，或另一个 App 在登录账户时，会显示一个 8 位的码。在这里输入，核对后批准。'),
        const SizedBox(height: 8),
        TextField(controller: code, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: '码（XXXX-XXXX）', border: OutlineInputBorder()), onSubmitted: (_) => _lookup()),
        const SizedBox(height: 8),
        FilledButton(onPressed: busy ? null : _lookup, child: const Text('下一步')),
        if (done != null) Text(done!),
      ]),
      if (p != null) Section('核对后再批准', [
        if ('${p['check'] ?? ''}'.isNotEmpty) ...[
          const Text('核对词'),
          Text('${p['check']}', style: const TextStyle(fontSize: 36, letterSpacing: 6)),
          const Text('与 ta 刚才在对话里发给你的 3 个表情一致，才批准。对不上就拒绝。', style: TextStyle(fontSize: 12)),
          const SizedBox(height: 8),
        ],
        if (p['choose'] == null) Text('agent：${(p['agent'] as Map?)?['name']}'),
        if (p['choose'] is List && (p['choose'] as List).isNotEmpty) ...[
          const Text('接进哪个 agent：'),
          RadioGroup<String>(
            groupValue: agent ?? '${((p['choose'] as List).first as Map)['id']}',
            onChanged: (v) => setState(() => agent = v),
            child: Column(children: [
              for (final x in [...((p['choose'] as List).cast<Map>().map((m) => MapEntry('${m['id']}', '${m['name']}${'${m['repo'] ?? ''}'.isNotEmpty ? ' · ${m['repo']}' : ''}'))), MapEntry('new', '新建一个（${(p['agent'] as Map?)?['name']}）')])
                RadioListTile<String>(dense: true, contentPadding: EdgeInsets.zero, value: x.key, title: Text(x.value)),
            ]),
          ),
        ],
        Text('身体：${p['body']}'),
        Text('类型：${_kind['${p['kind']}'] ?? p['kind']}'),
        if ('${p['version'] ?? ''}'.isNotEmpty) Text('版本：${p['version']}'),
        if (p['kind'] != 'console') ...[
          Row(children: [const Text('公钥指纹：'), SelectableText('${p['fingerprint']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 18))]),
          if ('${p['check'] ?? ''}'.isEmpty) const Text('必须与那具身体的「多具身体」页上显示的指纹一致。不一致就拒绝。', style: TextStyle(fontSize: 12)),
        ],
        if ('${p['soulKey'] ?? ''}'.isNotEmpty) ...[
          Text('部署密钥：${p['soulKey']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
          if (p['soulLink'] == true) const Text('批准后会在浏览器里经 GitHub 跳一下，把这把密钥加到灵魂仓库（只加这一把，只对这一个仓库）。', style: TextStyle(fontSize: 12)),
        ],
        if (p['kind'] == 'console') Text('这是「控制台登录」：批准后，${p['body']} 上的 App 能管理你的整个账户。只批准你自己刚刚在那台设备上发起的请求。', style: const TextStyle(color: Colors.orange)),
        if (p['newAgent'] == true) const Text('这是你账户下的一个新 agent：批准后会新建它。'),
        if (p['replaces'] == true) const Text('这具身体已经绑定过：批准后旧的绑定立即失效。', style: TextStyle(color: Colors.orange)),
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
          const Padding(padding: EdgeInsets.all(4), child: Text('各身体上的 App 经运行基座管理这个账户。不再使用的设备在这里吊销，立即失效。')),
          Section('控制台登录', [
            if (list.isEmpty) const Text('没有。'),
            for (final c in list) ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('来自身体 ${c['body']}${c['current'] == true ? '（就是这个 App）' : ''}'),
              subtitle: Text('登录于 ${_ago(c['created'])} · 最近使用 ${_ago(c['lastUsed'])}'),
              trailing: TextButton(onPressed: () async {
                final self = c['current'] == true;
                if (await confirm(context, '吊销', self ? '这是这个 App 自己的登录：吊销后要重新登录才能管理账户。确定吗？' : '那台设备上的 App 将不能再管理账户。确定吗？') && context.mounted) {
                  await act(context, () => api.call('account.revokeConsole', {'id': c['id']}), ok: '已吊销');
                  if (self) { await api.call('account').then((r) => api.status['account'] = r).catchError((_) => null); }
                  _reload();
                }
              }, child: const Text('吊销', style: TextStyle(color: Colors.red))),
            ),
          ]),
        ]);
      });
}

class _Settings extends StatelessWidget {
  const _Settings();
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(12), children: [
        Section('退出登录', [
          const Text('只退出这个 App 的账户登录（作废它的令牌）；这具身体仍绑定在账户下，与其他身体照常连接。'),
          Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () => act(context, () => api.call('account.signOut'), ok: '已退出'), child: const Text('退出登录'))),
        ]),
        Section('删除账户', [
          const Text('删除后，账户、所有 agent 与身体的登记、所有控制台登录立即删除，所有身体随即断开。灵魂仓库与各身体上的数据不受影响；以后可以重新登录、重新绑定。'),
          Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () async {
            if (await confirm(context, '删除账户', '账户与所有 agent、身体的登记都会删除，所有身体立即断开。这一步不能撤销。确定吗？') && context.mounted) {
              await act(context, () => api.call('account.delete'), ok: '账户已删除');
            }
          }, child: const Text('删除账户', style: TextStyle(color: Colors.red)))),
        ]),
      ]);
}

class _ErrorView extends StatelessWidget {
  final Object error;
  final VoidCallback onRetry;
  const _ErrorView({required this.error, required this.onRetry});
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(12), children: [
        Section('出错了', [Text(_err(error), style: const TextStyle(color: Colors.red)), TextButton(onPressed: onRetry, child: const Text('重试'))]),
      ]);
}
