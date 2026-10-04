// 多 agent：连接档案的切换与管理、当前 agent 的身份资料、身体列表、记忆历史。
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';

/// 顶栏标题：当前 agent 的名字，点击切换。
class AgentSwitcher extends ApiWidget {
  const AgentSwitcher({super.key});
  @override
  Widget view(BuildContext context) => InkWell(
        onTap: () => showAgentSheet(context),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          CircleAvatar(radius: 6, backgroundColor: api.color),
          const SizedBox(width: 8),
          Flexible(child: Text(api.name, overflow: TextOverflow.ellipsis)),
          const Icon(Icons.arrow_drop_down),
        ]),
      );
}

void showAgentSheet(BuildContext context) => showSheet(context, (_, scroll) => _AgentSheet(scroll: scroll), initial: 0.5, maxWidth: 520);

class _AgentSheet extends StatefulWidget {
  final ScrollController? scroll;
  const _AgentSheet({this.scroll});
  @override
  State<_AgentSheet> createState() => _AgentSheetState();
}

class _AgentSheetState extends State<_AgentSheet> {
  final alive = <String, bool>{};
  @override
  void initState() {
    super.initState();
    for (final p in api.profiles) {
      _probe(p);
    }
  }

  Future<void> _probe(Profile p) async {
    final probe = Api()..profiles = [p]..current = p;
    final ok = await probe.health();
    if (mounted) setState(() => alive[p.id] = ok);
  }

  @override
  Widget build(BuildContext context) => SafeArea(
        child: ListView(shrinkWrap: true, controller: widget.scroll, children: [
          const ListTile(title: Text('切换 agent'), subtitle: Text('每个 agent 有自己的运行基座、身份与灵魂')),
          for (final p in api.profiles)
            ListTile(
              leading: Icon(Icons.circle, size: 14, color: alive[p.id] == null ? Colors.grey : alive[p.id]! ? Colors.green : Colors.red),
              title: Text(p.label.isEmpty ? '（未配对）' : p.label),
              subtitle: Text(p.base),
              selected: p == api.current,
              trailing: IconButton(
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  if (await confirm(context, '移除连接', '只移除控制台里的这个连接，不会影响运行基座与它的记忆。')) { await api.removeProfile(p); if (context.mounted) Navigator.pop(context); }
                },
              ),
              onTap: () { api.switchTo(p); Navigator.pop(context); },
            ),
          ListTile(
            leading: const Icon(Icons.add),
            title: const Text('连接新的 agent'),
            onTap: () async {
              final c = TextEditingController(text: 'http://127.0.0.1:7789');
              final ok = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
                title: const Text('网关地址'),
                content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(helperText: '另一台机器填它的地址（如 http://192.168.1.8:7788）；同一设备上的另一个 agent 通常用不同端口')),
                actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('下一步'))],
              ));
              if (ok == true) { await api.addProfile(c.text.trim()); if (context.mounted) Navigator.pop(context); }
            },
          ),
        ]),
      );
}

const _palette = ['#F0A35E', '#E0607E', '#27AE60', '#2D9CDB', '#56CCF2', '#BB6BD9', '#EB5757', '#6FCF97', '#F2C94C', '#7C6CF2']; // 首项为官网设计系统的琥珀，即默认色

/// 身份资料：名字、代词、简介、主题色。保存后写入灵魂仓库的 agent.json，所有身体同步。
class IdentityPage extends StatefulWidget {
  const IdentityPage({super.key});
  @override
  State<IdentityPage> createState() => _IdentityPageState();
}

class _IdentityPageState extends State<IdentityPage> {
  final f = <String, TextEditingController>{};
  String color = '#F0A35E';
  Map? a;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    if (!mounted) return;
    final r = await act(context, () => api.call<Map>('agent'));
    if (!mounted || r == null) return;
    setState(() {
      a = r; color = '${r['color']}';
      for (final k in ['displayName', 'name', 'pronouns', 'description', 'language']) { f[k] = TextEditingController(text: '${r[k] ?? ''}'); }
    });
  }

  @override
  Widget build(BuildContext context) {
    final a = this.a;
    return PageFrame(
      title: '身份',
      body: a == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        if (a['seed'] == true) const Banner0(text: '这是自动生成的初始身份。给她 / 他 / 它起个名字吧。', color: Colors.amber),
        for (final e in {'displayName': '显示名', 'name': '标识符（小写字母、数字、连字符）', 'pronouns': '代词（可空）', 'description': '一句话简介', 'language': '偏好语言（如 zh-CN）'}.entries)
          Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: TextField(controller: f[e.key], decoration: InputDecoration(labelText: e.value, border: const OutlineInputBorder()))),
        const Text('主题色'),
        Wrap(spacing: 8, children: [
          for (final c in [..._palette, if (!_palette.contains(color.toUpperCase()) && !_palette.contains(color)) color]) // 她自己选的颜色（edit_identity）也显示出来
            ChoiceChip(
              label: const SizedBox(width: 16, height: 16),
              avatar: CircleAvatar(backgroundColor: Color(int.parse('FF${c.substring(1)}', radix: 16))),
              selected: color == c, onSelected: (_) => setState(() => color = c),
            ),
        ]),
        const SizedBox(height: 12),
        Text('ID：${a['id']}', style: Theme.of(context).textTheme.bodySmall),
        Text('诞生：${a['createdAt']}', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: () async {
            await act(context, () => api.call('setAgent', {for (final k in f.keys) k: f[k]!.text.trim(), 'color': color}), ok: '已保存，所有身体都会同步');
            await api.refresh();
            if (mounted) _load();
          },
          child: const Text('保存'),
        ),
      ]),
    );
  }
}

/// 记忆历史：灵魂仓库的每一次提交（哪具身体、什么时候、改了什么），可以查看差异或撤销。
class HistoryPage extends StatefulWidget {
  const HistoryPage({super.key});
  @override
  State<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends State<HistoryPage> {
  List items = [];
  List bodies = [];
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => Future.wait([api.call<List>('soulHistory', {'limit': 80}), api.call<List>('bodies')]));
    final h = r?[0], b = r?[1];
    if (mounted) setState(() { items = h ?? []; bodies = b ?? []; });
  }

  @override
  Widget build(BuildContext context) => PageFrame(
        title: '记忆历史',
        body: RefreshIndicator(
          onRefresh: _load,
          child: ListView(children: [
            Section('身体', [
              for (final b in bodies) ListTile(dense: true, leading: const Icon(Icons.devices), title: Text('${b['body']}'), subtitle: Text('最近同步：${b['lastSeen'] ?? '-'}　运行基座 ${b['runtime'] ?? b['bridge'] ?? '-'}')),
              if (bodies.isEmpty) const Text('还没有身体登记'),
            ]),
            for (final c in items)
              ListTile(
                leading: const Icon(Icons.commit),
                title: Text('${c['subject']}'),
                subtitle: Text('${c['author']} · ${hm(c['ts'])}${'${c['stat']}'.isNotEmpty ? '\n${c['stat']}' : ''}'),
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => _Commit(c as Map, onReverted: _load))),
              ),
          ]),
        ),
      );
}

class _Commit extends StatelessWidget {
  final Map c;
  final VoidCallback onReverted;
  const _Commit(this.c, {required this.onReverted});
  @override
  Widget build(BuildContext context) => PageFrame(
        title: '${c['short']}', actions: [
          TextButton(
            onPressed: () async {
              if (!await confirm(context, '撤销这次变更', '会生成一个反向提交（历史仍然保留），所有身体都会同步。她会知道有人撤销了这段变更。')) return;
              if (!context.mounted) return;
              final ok = await act(context, () => api.call('soulRevert', {'hash': c['hash']}), ok: '已撤销');
              if (ok != null && context.mounted) { onReverted(); Navigator.pop(context); }
            },
            child: const Text('撤销'),
          ),
        ],
        body: FutureBuilder<String>(
          future: api.call<String>('soulShow', {'hash': c['hash']}),
          builder: (_, s) => s.hasData
              ? SingleChildScrollView(padding: const EdgeInsets.all(12), child: SelectableText(s.data!, style: const TextStyle(fontFamily: 'monospace', fontSize: 11)))
              : Center(child: s.hasError ? Text('${s.error}') : const CircularProgressIndicator()),
        ),
      );
}
