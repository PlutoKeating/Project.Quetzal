// 多 agent：连接档案的切换与管理、当前 agent 的身份资料、身体列表、记忆历史。
import 'package:flutter/material.dart';
import '../api.dart';
import '../pins.dart';
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
          const ListTile(title: Text('切换')),
          for (final p in api.profiles)
            ListTile(
              leading: Icon(Icons.circle, size: 14, color: alive[p.id] == null ? Colors.grey : alive[p.id]! ? Colors.green : Colors.red),
              title: Text(p.label.isEmpty ? '（未配对）' : p.label),
              subtitle: Text(p.base),
              selected: p == api.current,
              trailing: IconButton(
                icon: const Icon(Icons.delete_outline),
                onPressed: () async {
                  if (await confirm(context, '移除', '只从这里移除，ta 本身不受影响。')) { await api.removeProfile(p); if (context.mounted) Navigator.pop(context); }
                },
              ),
              onTap: () { api.switchTo(p); Navigator.pop(context); },
            ),
          ListTile(
            leading: const Icon(Icons.add),
            title: const Text('连接另一个'),
            onTap: () async {
              final c = TextEditingController();
              final ok = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
                title: const Text('地址'),
                content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(hintText: '192.168.1.8')),
                actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('下一步'))],
              ));
              if (ok != true) return;
              final b = normalizeBase(c.text);
              if (b == null) { if (context.mounted) toast(context, '地址不对，例如 192.168.1.8'); return; }
              await api.addProfile(b);
              if (context.mounted) Navigator.pop(context);
            },
          ),
        ]),
      );
}

const _palette = ['#F0A35E', '#E0607E', '#27AE60', '#2D9CDB', '#56CCF2', '#BB6BD9', '#EB5757', '#6FCF97', '#F2C94C', '#7C6CF2']; // 首项为官网设计系统的琥珀，即默认色

/// 身份资料：名字、代词、简介、语言、主题色。保存后写入灵魂仓库的 agent.json，所有身体同步。
/// 标识符（name）用于仓库命名与提交署名，一般不改，不放在这里（她可以用 edit_identity 改）。
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
      for (final k in ['displayName', 'pronouns', 'description', 'language']) { f[k] = TextEditingController(text: '${r[k] ?? ''}'); }
    });
  }

  @override
  Widget build(BuildContext context) {
    final a = this.a;
    return PageFrame(
      title: '身份',
      body: a == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        if (a['seed'] == true) const Padding(padding: EdgeInsets.fromLTRB(4, 4, 4, 8), child: Text('给 ta 起个名字吧')),
        for (final e in {'displayName': '名字', 'pronouns': '代词', 'description': '简介', 'language': '语言'}.entries)
          Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: TextField(controller: f[e.key], decoration: InputDecoration(labelText: e.value, border: const OutlineInputBorder()))),
        const SizedBox(height: 8),
        Wrap(spacing: 8, children: [
          for (final c in [..._palette, if (!_palette.contains(color.toUpperCase()) && !_palette.contains(color)) color]) // 她自己选的颜色（edit_identity）也显示出来
            ChoiceChip(
              label: const SizedBox(width: 16, height: 16),
              avatar: CircleAvatar(backgroundColor: Color(int.parse('FF${c.substring(1)}', radix: 16))),
              selected: color == c, onSelected: (_) => setState(() => color = c),
            ),
        ]),
        const SizedBox(height: 12),
        Text('诞生于 ${'${a['createdAt'] ?? ''}'.split('T').first}', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 12),
        FilledButton(
          onPressed: () async {
            await act(context, () => api.call('setAgent', {for (final k in f.keys) k: f[k]!.text.trim(), 'color': color}), ok: '已保存');
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
            if (bodies.isNotEmpty) Section('设备', [
              for (final b in bodies) ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: const Icon(Icons.devices), title: Text('${b['body']}'), subtitle: Text('${b['lastSeen'] ?? '-'} · ${b['runtime'] ?? b['bridge'] ?? '-'}')),
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
              if (!await confirm(context, '撤销这次变更', '历史仍会保留，她会知道。')) return;
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
