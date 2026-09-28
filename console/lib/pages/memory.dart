// 记忆：她是谁、记得什么。核心（人格 + 常驻记忆）/ 日记 / 笔记 / 搜索。
// 你对记忆的任何修改，她下次醒来都会知道（写入她的日记），不会被悄悄篡改。
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';

class MemoryPage extends StatelessWidget {
  const MemoryPage({super.key});
  @override
  Widget build(BuildContext context) => const DefaultTabController(
        length: 4,
        child: Column(children: [
          TabBar(tabs: [Tab(text: '核心'), Tab(text: '日记'), Tab(text: '笔记'), Tab(text: '搜索')]),
          Expanded(child: TabBarView(children: [_Core(), _Journal(), _Notes(), _Search()])),
        ]),
      );
}

class _Core extends StatefulWidget {
  const _Core();
  @override
  State<_Core> createState() => _CoreState();
}

class _CoreState extends State<_Core> {
  Map? m;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { final r = await act(context, () => api.call<Map>('memory')); if (mounted && r != null) setState(() => m = r); }

  Future<void> _edit(String target, {String? old}) async {
    final c = TextEditingController(text: old ?? '');
    final r = await showDialog<String>(context: context, builder: (x) => AlertDialog(
      title: Text(old == null ? '新增条目' : '修改条目'),
      content: TextField(controller: c, maxLines: 6, minLines: 2, autofocus: true),
      actions: [
        if (old != null) TextButton(onPressed: () => Navigator.pop(x, '__del__'), child: const Text('删除', style: TextStyle(color: Colors.red))),
        TextButton(onPressed: () => Navigator.pop(x), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(x, c.text), child: const Text('保存')),
      ],
    ));
    if (r == null || !mounted) return;
    final args = r == '__del__' ? {'target': target, 'action': 'remove', 'oldText': old} : old == null ? {'target': target, 'action': 'add', 'content': r} : {'target': target, 'action': 'replace', 'content': r, 'oldText': old};
    final res = await act(context, () => api.call<String>('editMemory', args));
    if (res != null && mounted) toast(context, res.split('\n').first);
    _load();
  }

  Future<void> _editSoul() async {
    final c = TextEditingController(text: m?['soul'] ?? '');
    final ok = await Navigator.push<bool>(context, MaterialPageRoute(builder: (x) => Scaffold(
      appBar: AppBar(title: const Text('人格 SOUL.md'), actions: [TextButton(onPressed: () => Navigator.pop(x, true), child: const Text('保存'))]),
      body: Padding(padding: const EdgeInsets.all(12), child: TextField(controller: c, maxLines: null, expands: true, decoration: const InputDecoration(border: OutlineInputBorder()))),
    )));
    if (ok == true && mounted) { await act(context, () => api.call('setSoul', {'text': c.text}), ok: '已保存，她会知道你改过'); _load(); }
  }

  Widget _entries(String title, String target, List list) {
    final used = list.fold<int>(0, (a, e) => a + '$e'.length + 3);
    return Section('$title · $used 字', [
      for (final e in list) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('$e'), onTap: () => _edit(target, old: '$e')),
      if (list.isEmpty) const Text('（空）'),
    ], trailing: IconButton(icon: const Icon(Icons.add), onPressed: () => _edit(target)));
  }

  @override
  Widget build(BuildContext context) {
    final m = this.m;
    if (m == null) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
        Section('人格', [Text('${m['soul']}', maxLines: 8, overflow: TextOverflow.fade)], trailing: IconButton(icon: const Icon(Icons.edit), onPressed: _editSoul)),
        _entries('她的笔记（MEMORY）', 'memory', m['memory'] as List),
        _entries('关于你（USER）', 'user', m['user'] as List),
        Section('未完成的念头', [for (final l in (m['loops'] as List)) Text('· ${l['text']}'), if ((m['loops'] as List).isEmpty) const Text('（无）')]),
      ]),
    );
  }
}

class _Journal extends StatefulWidget {
  const _Journal();
  @override
  State<_Journal> createState() => _JournalState();
}

class _JournalState extends State<_Journal> {
  List days = [];
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { final r = await act(context, () => api.call<List>('journalList')); if (mounted && r != null) setState(() => days = r); }
  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(children: [
          if (days.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('还没有日记', textAlign: TextAlign.center)),
          for (final d in days)
            ListTile(
              leading: const Icon(Icons.menu_book),
              title: Text('${d['day']}'),
              subtitle: Text('${d['body']}'),
              onTap: () => _open(context, '${d['day']} · ${d['body']}', () => api.call<String>('journal', {'body': d['body'], 'day': d['day']})),
            ),
        ]),
      );
}

class _Notes extends StatefulWidget {
  const _Notes();
  @override
  State<_Notes> createState() => _NotesState();
}

class _NotesState extends State<_Notes> {
  List notes = [];
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { final r = await act(context, () => api.call<List>('notes')); if (mounted && r != null) setState(() => notes = r); }
  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(children: [
          if (notes.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('还没有笔记', textAlign: TextAlign.center)),
          for (final n in notes)
            ListTile(leading: const Icon(Icons.sticky_note_2), title: Text('${n['name']}'), subtitle: Text(hm(n['mtime'])), onTap: () => _open(context, '${n['name']}', () => api.call<String>('note', {'name': n['name']}))),
        ]),
      );
}

class _Search extends StatefulWidget {
  const _Search();
  @override
  State<_Search> createState() => _SearchState();
}

class _SearchState extends State<_Search> {
  String result = '';
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(12), children: [
        TextField(
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '在笔记和日记中搜索（包括其他身体的日记）', border: OutlineInputBorder()),
          onSubmitted: (q) async { final r = await act(context, () => api.call<String>('search', {'query': q})); if (mounted) setState(() => result = r ?? ''); },
        ),
        const SizedBox(height: 12),
        SelectableText(result),
      ]);
}

void _open(BuildContext context, String title, Future<String> Function() load) {
  Navigator.push(context, MaterialPageRoute(builder: (_) => Scaffold(
    appBar: AppBar(title: Text(title)),
    body: FutureBuilder<String>(future: load(), builder: (_, s) => s.hasData ? SingleChildScrollView(padding: const EdgeInsets.all(16), child: SelectableText(s.data!)) : const Center(child: CircularProgressIndicator())),
  )));
}
