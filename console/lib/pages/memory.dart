// 记忆：她是谁、记得什么。核心（人格 + 常驻记忆）/ 日记 / 笔记 / 搜索。人格、条目、日记、笔记与搜索结果都按完整 Markdown 渲染。
// 你对记忆的任何修改，她下次醒来都会知道（写入她的日记），不会被悄悄篡改。
//   手机：四个 Tab；桌面：列表栏放索引（日记按天、笔记目录树），主区放内容。各块（MemoryCore、JournalList、NotesList、MemorySearch、MarkdownDoc）两边共用。
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';

class MemoryPage extends StatelessWidget {
  const MemoryPage({super.key});
  @override
  Widget build(BuildContext context) => DefaultTabController(
        length: 4,
        child: Column(children: [
          const TabBar(tabs: [Tab(text: '核心'), Tab(text: '日记'), Tab(text: '笔记'), Tab(text: '搜索')]),
          Expanded(child: TabBarView(children: [
            const MemoryCore(),
            JournalList(onOpen: (d) => openDoc(context, '${d['day']} · ${d['body']}', () => api.call<String>('journal', {'body': d['body'], 'day': d['day']}))),
            NotesList(onOpen: (n) => openDoc(context, '${n['name']}', () => api.call<String>('note', {'name': n['name']}))),
            const MemorySearch(),
          ])),
        ]),
      );
}

/// 核心：人格、常驻记忆（MEMORY / USER）、未完成的念头；可编辑。
class MemoryCore extends StatefulWidget {
  const MemoryCore({super.key});
  @override
  State<MemoryCore> createState() => _CoreState();
}

class _CoreState extends State<MemoryCore> with ReloadOnConnect {
  @override
  void reloadOnConnect() => _load();
  Map? m;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { if (api.conn != Conn.online) return; final r = await act(context, () => api.call<Map>('memory')); if (mounted && r != null) setState(() => m = r); }

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
    final ok = await Navigator.push<bool>(context, MaterialPageRoute(builder: (x) => PageFrame(
      title: '人格 SOUL.md',
      actions: [TextButton(onPressed: () => Navigator.pop(x, true), child: const Text('保存'))],
      body: Padding(padding: const EdgeInsets.all(12), child: TextField(controller: c, maxLines: null, expands: true, decoration: const InputDecoration(border: OutlineInputBorder()))),
    )));
    if (ok == true && mounted) { await act(context, () => api.call('setSoul', {'text': c.text}), ok: '已保存，她会知道你改过'); _load(); }
  }

  Widget _entries(String title, String target, List list) {
    final used = list.fold<int>(0, (a, e) => a + '$e'.length + 3);
    return Section('$title · $used 字', [
      for (final e in list)
        ListTile(dense: true, contentPadding: EdgeInsets.zero, title: RichMarkdown('$e', selectable: false), trailing: const Icon(Icons.edit_outlined, size: 16), onTap: () => _edit(target, old: '$e')),
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
        Section('人格', [
          // 折叠预览（Markdown），点开看全文；编辑用右上角的笔
          InkWell(
            onTap: () => openDoc(context, '人格 SOUL.md', () async => '${m['soul']}'),
            child: ClipRect(child: SizedBox(height: 220, child: OverflowBox(alignment: Alignment.topLeft, maxHeight: double.infinity, child: RichMarkdown('${m['soul']}', selectable: false)))),
          ),
          TextButton(onPressed: () => openDoc(context, '人格 SOUL.md', () async => '${m['soul']}'), child: const Text('查看全文')),
        ], trailing: IconButton(icon: const Icon(Icons.edit), onPressed: _editSoul)),
        _entries('她的笔记（MEMORY）', 'memory', m['memory'] as List),
        _entries('关于你（USER）', 'user', m['user'] as List),
        Section('未完成的念头', [
          if ((m['loops'] as List).isEmpty) const Text('（无）') else RichMarkdown((m['loops'] as List).map((l) => '- ${l['text']}').join('\n')),
        ]),
      ]),
    );
  }
}

/// 日记：每具身体每天一篇。selected：桌面列表栏里高亮当前打开的一篇（`<body>/<day>`）。
class JournalList extends StatefulWidget {
  final void Function(Map day) onOpen;
  final String? selected;
  const JournalList({super.key, required this.onOpen, this.selected});
  @override
  State<JournalList> createState() => _JournalState();
}

class _JournalState extends State<JournalList> with ReloadOnConnect {
  @override
  void reloadOnConnect() => _load();
  List days = [];
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { if (api.conn != Conn.online) return; final r = await act(context, () => api.call<List>('journalList')); if (mounted && r != null) setState(() => days = r); }
  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(children: [
          if (days.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('还没有日记', textAlign: TextAlign.center)),
          for (final d in days)
            ListTile(
              dense: ShellScope.isDesktop(context),
              selected: widget.selected == '${d['body']}/${d['day']}',
              leading: const Icon(Icons.menu_book),
              title: Text('${d['day']}'),
              subtitle: Text('${d['body']}'),
              onTap: () => widget.onOpen(d as Map),
            ),
        ]),
      );
}

/// 笔记：目录树中的全部笔记（name 为相对路径）。
class NotesList extends StatefulWidget {
  final void Function(Map note) onOpen;
  final String? selected;
  const NotesList({super.key, required this.onOpen, this.selected});
  @override
  State<NotesList> createState() => _NotesState();
}

class _NotesState extends State<NotesList> with ReloadOnConnect {
  @override
  void reloadOnConnect() => _load();
  List notes = [];
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { if (api.conn != Conn.online) return; final r = await act(context, () => api.call<List>('notes')); if (mounted && r != null) setState(() => notes = r); }
  @override
  Widget build(BuildContext context) => RefreshIndicator(
        onRefresh: _load,
        child: ListView(children: [
          if (notes.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Text('还没有笔记', textAlign: TextAlign.center)),
          for (final n in notes)
            ListTile(dense: ShellScope.isDesktop(context), selected: widget.selected == '${n['name']}', leading: const Icon(Icons.sticky_note_2), title: Text('${n['name']}'), subtitle: Text([if ('${n['summary'] ?? ''}'.isNotEmpty) plainPreview('${n['summary']}'), hm(n['mtime'])].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis), onTap: () => widget.onOpen(n as Map)),
        ]),
      );
}

/// 搜索笔记与日记（含其他身体的日记），结果按 Markdown 渲染。
class MemorySearch extends StatefulWidget {
  const MemorySearch({super.key});
  @override
  State<MemorySearch> createState() => _SearchState();
}

class _SearchState extends State<MemorySearch> {
  String result = '';
  @override
  Widget build(BuildContext context) => ListView(padding: const EdgeInsets.all(12), children: [
        TextField(
          autofocus: ShellScope.isDesktop(context),
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '搜索记忆', border: OutlineInputBorder()),
          onSubmitted: (q) async { final r = await act(context, () => api.call<String>('search', {'query': q})); if (mounted) setState(() => result = r ?? ''); },
        ),
        const SizedBox(height: 12),
        RichMarkdown(result),
      ]);
}

/// 一篇 Markdown 文档（日记、笔记、人格全文）：加载并渲染。
class MarkdownDoc extends StatelessWidget {
  final Future<String> Function() load;
  final Key? reloadKey;
  const MarkdownDoc({super.key, required this.load, this.reloadKey});
  @override
  Widget build(BuildContext context) => FutureBuilder<String>(
        key: reloadKey,
        future: load(),
        builder: (_, s) => s.hasData
            ? LayoutBuilder(builder: (context, box) => PaneWidth(width: box.maxWidth, child: SingleChildScrollView(padding: EdgeInsets.symmetric(horizontal: ShellScope.isDesktop(context) ? 28 : 16, vertical: 16), child: RichMarkdown(s.data!))))
            : s.hasError ? Center(child: Text('${s.error}')) : const Center(child: CircularProgressIndicator()),
      );
}

/// 推入一篇文档页（手机）。
void openDoc(BuildContext context, String title, Future<String> Function() load) {
  Navigator.push(context, MaterialPageRoute(builder: (_) => PageFrame(title: title, body: MarkdownDoc(load: load))));
}
