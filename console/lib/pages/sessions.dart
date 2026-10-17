// 会话：多个会话可以同时进行；每个会话都能看到其他会话（后端在系统提示里提供），不是彼此隔离的。
// 这里管理会话：新建、打开、重命名、归档；「已归档」里可以找回。正在进行的会话带有标记。
// #30：置顶（排在最前）、列表内搜索（标题与内容，标出命中片段，点开定位到那条消息）、筛选与排序（来源通道、进行中、置顶、时间范围、项目）、
//      项目（按项目分组或只看一个项目，移到项目，项目的新建 / 编辑 / 删除）。手机外壳与桌面外壳（及网页版）共用这一个列表。
import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import 'chat.dart';
import 'projects.dart';

/// 打开聊天：进入最近的会话；还没有会话时新建一个。
Future<void> openChat(BuildContext context) async {
  final list = await act(context, () => api.call<List>('sessions'));
  if (list == null || !context.mounted) return;
  final s = list.isNotEmpty ? list.first as Map : await act(context, () => api.call<Map>('sessions.create'));
  if (s != null && context.mounted) await Navigator.push(context, MaterialPageRoute(builder: (_) => ChatPage(conv: '${s['id']}', title: '${s['title']}')));
}

/// 手机：会话列表页。
class SessionsPage extends StatelessWidget {
  final String? current;
  const SessionsPage({super.key, this.current});
  @override
  Widget build(BuildContext context) => SessionsList(
        current: current,
        framed: true,
        onOpen: (s) => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ChatPage(conv: '${s['id']}', title: '${s['title']}'))),
      );
}

/// 来源通道的筛选项：键是会话的 channel（「子agent」：有子 agent 报告送回的会话）。
const sessionChannels = <String, String>{'控制台': '控制台', '飞书': '飞书', '主动': '主动消息', '语音': '语音', '子agent': '子 agent'};
/// 时间范围：最近更新落在多少天以内（0 = 今天）。
const sessionRanges = <String, String>{'today': '今天', 'week': '7 天内', 'month': '30 天内'};
const sessionSorts = <String, String>{'updated': '最近更新', 'created': '创建时间', 'title': '标题'};

/// 列表的筛选条件。
class SessionFilter {
  String sort = 'updated';
  String? channel, range, project; // project：项目 id，'none' 为不属于项目
  bool live = false, pinned = false;
  bool get active => channel != null || range != null || project != null || live || pinned;
  void clear() { channel = null; range = null; project = null; live = false; pinned = false; }

  Map<String, dynamic> params(bool archived, {DateTime? now}) {
    final t = now ?? DateTime.now();
    final day = DateTime(t.year, t.month, t.day);
    final from = switch (range) { 'today' => day, 'week' => day.subtract(const Duration(days: 6)), 'month' => day.subtract(const Duration(days: 29)), _ => null };
    return {
      'archived': archived, 'sort': sort,
      'channel': ?channel, 'project': ?project,
      if (live) 'live': true, if (pinned) 'pinned': true,
      if (from != null) 'from': from.millisecondsSinceEpoch,
    };
  }
}

/// 一段文字按高亮位置拆成几段（命中的加粗、带底色）。marks：[[起, 止], …]。
List<TextSpan> highlightSpans(String text, List marks, TextStyle hit) {
  final out = <TextSpan>[];
  var at = 0;
  for (final m in marks) {
    if (m is! List || m.length != 2) continue;
    final a = (m[0] as num).toInt().clamp(at, text.length), b = (m[1] as num).toInt().clamp(a, text.length);
    if (a > at) out.add(TextSpan(text: text.substring(at, a)));
    if (b > a) out.add(TextSpan(text: text.substring(a, b), style: hit));
    at = b;
  }
  if (at < text.length) out.add(TextSpan(text: text.substring(at)));
  return out;
}

/// 按项目分组：置顶的一组在最前，然后每个项目一组（按项目名），最后是不属于项目的。返回 [(标题, 项目或空, 会话)]。
List<({String key, String title, Map? project, List<Map> items})> groupSessions(List<Map> sessions, ProjectStore store) {
  final pinned = <Map>[], none = <Map>[], by = <String, List<Map>>{};
  for (final s in sessions) {
    final p = store.byId(s['project'] as String?);
    if (((s['pinned'] as num?) ?? 0) > 0) { pinned.add(s); } else if (p == null) { none.add(s); } else { (by['${p['id']}'] ??= []).add(s); }
  }
  final groups = <({String key, String title, Map? project, List<Map> items})>[];
  if (pinned.isNotEmpty) groups.add((key: 'pinned', title: '置顶', project: null, items: pinned));
  final ids = by.keys.toList()..sort((a, b) => '${store.byId(a)!['name']}'.compareTo('${store.byId(b)!['name']}'));
  for (final id in ids) { final p = store.byId(id)!; groups.add((key: id, title: '${p['name']}', project: p, items: by[id]!)); }
  if (none.isNotEmpty) groups.add((key: 'none', title: ids.isEmpty && pinned.isEmpty ? '' : '未归入项目', project: null, items: none));
  return groups;
}

/// 会话列表：新建、打开、重命名、归档与找回、置顶、移到项目、搜索、筛选与排序、按项目分组。framed：手机上套 AppBar 与新建按钮；桌面列表栏里直接用。
class SessionsList extends StatefulWidget {
  final String? current;
  final bool framed;
  final void Function(Map session) onOpen;
  const SessionsList({super.key, this.current, required this.onOpen, this.framed = false});
  @override
  State<SessionsList> createState() => _SessionsListState();
}

class _SessionsListState extends State<SessionsList> {
  List<Map> sessions = [];
  List<Map>? hits; // 搜索结果（搜索框有字时）
  String? searchError;
  Set<String> running = {};
  bool archived = false, grouped = false;
  final filter = SessionFilter();
  final query = TextEditingController();
  Timer? debounce;
  StreamSubscription? sub;
  int _gen = 0; // 只采用最近一次加载的结果

  @override
  void initState() {
    super.initState();
    _wasOnline = api.conn == Conn.online;
    _load();
    unawaited(projectStore.load());
    projectStore.addListener(_onProjects);
    sub = api.events.where((e) => (e.name == 'activity' && const ['start', 'done', 'error'].contains((e.data as Map)['kind'])) || e.name == 'session.switch' || e.name == 'say' || e.name == 'replica' || e.name == 'projects').listen((_) => _load()); // replica：其他身体的对话到了
    api.addListener(_onConn);
  }

  bool _wasOnline = false; // 初值在 initState 里按此刻的连接状态设：创建时还没连上，连上那一刻就要重新加载
  void _onConn() { final on = api.conn == Conn.online; if (on && !_wasOnline) { _load(); projectStore.load(); } _wasOnline = on; }
  void _onProjects() { if (mounted) setState(() {}); }

  @override
  void dispose() { sub?.cancel(); debounce?.cancel(); query.dispose(); projectStore.removeListener(_onProjects); api.removeListener(_onConn); super.dispose(); }

  /// 外部（桌面外壳）要求刷新。
  void reload() => _load();

  bool get searching => query.text.trim().isNotEmpty;

  Future<void> _load() async {
    final gen = ++_gen;
    try {
      if (searching) {
        final r = await Future.wait([api.call<List>('sessions.search', {'query': query.text.trim()}), api.call<List>('sessions.live')]);
        if (!mounted || gen != _gen) return;
        setState(() { hits = r[0].cast<Map>(); searchError = null; running = r[1].cast<Map>().map((t) => '${t['conv']}').toSet(); });
        return;
      }
      final r = await Future.wait([api.call<List>('sessions', filter.params(archived)), api.call<List>('sessions.live')]);
      if (!mounted || gen != _gen) return;
      setState(() {
        hits = null;
        sessions = r[0].cast<Map>();
        running = r[1].cast<Map>().map((t) => '${t['conv']}').toSet();
      });
    } on RpcError catch (e) {
      if (mounted && gen == _gen && searching && e.code != 'OFFLINE') setState(() { hits = []; searchError = '连着的基座还不支持在会话里搜索（$e）'; });
    } catch (_) {}
  }

  void _onQuery(String _) {
    debounce?.cancel();
    debounce = Timer(const Duration(milliseconds: 250), _load);
    setState(() {});
  }

  void _open(Map s) => widget.onOpen(s);

  /// 搜索结果：有命中的消息就定位过去。
  void _openHit(Map h) {
    final s = h['session'] as Map, hit = h['hit'] as Map?;
    if (hit != null) chatFocus.value = (conv: '${s['id']}', msg: (hit['message'] as num).toInt());
    _open(s);
  }

  Future<void> _new() async {
    final p = filter.project != null && filter.project != 'none' ? filter.project : null; // 正在看一个项目：新会话就放进这个项目
    final s = await act(context, () => api.call<Map>('sessions.create', {'project': ?p}));
    if (s != null && mounted) _open(s);
  }

  Future<void> _rename(Map s) async {
    final c = TextEditingController(text: '${s['title']}');
    final ok = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
      title: const Text('重命名'), content: TextField(controller: c, autofocus: true),
      actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('保存'))],
    ));
    if (ok == true && mounted) { await act(context, () => api.call('sessions.rename', {'id': s['id'], 'title': c.text})); _load(); }
  }

  Future<void> _archive(Map s, bool v) async {
    await act(context, () => api.call('sessions.archive', {'id': s['id'], 'archived': v}), ok: v ? '已归档，可在「已归档」里找回' : '已找回');
    _load();
  }

  Future<void> _pin(Map s) async {
    final pinned = ((s['pinned'] as num?) ?? 0) > 0;
    await act(context, () => api.call('sessions.pin', {'id': s['id'], 'pinned': !pinned}));
    _load();
  }

  Future<void> _move(Map s) async {
    final to = await pickProject(context, current: s['project'] as String?);
    if (to == null || !mounted) return;
    final p = projectStore.byId(to);
    await act(context, () => api.call('sessions.move', {'id': s['id'], 'project': to.isEmpty ? null : to}), ok: to.isEmpty ? '已移出项目' : '已移到「${p?['name'] ?? '项目'}」');
    _load();
  }

  /// 筛选与排序：手机上从底部升起，桌面上是对话框。
  Future<void> _filters() async {
    await showSheet(context, (c, scroll) => StatefulBuilder(builder: (c, set) {
      void pick(void Function() f) { set(f); setState(() {}); _load(); }
      Widget group(String title, List<Widget> chips) => Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: Theme.of(c).textTheme.labelLarge), const SizedBox(height: 6), Wrap(spacing: 8, runSpacing: 6, children: chips)]),
          );
      ChoiceChip choice(String label, bool on, void Function() f) => ChoiceChip(label: Text(label), selected: on, onSelected: (_) => pick(f));
      return ListView(controller: scroll, shrinkWrap: true, padding: const EdgeInsets.only(bottom: 20), children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 12, 0),
          child: Row(children: [
            Expanded(child: Text('筛选与排序', style: Theme.of(c).textTheme.titleMedium)),
            TextButton(onPressed: filter.active ? () => pick(filter.clear) : null, child: const Text('清除筛选')),
          ]),
        ),
        group('排序', [for (final e in sessionSorts.entries) choice(e.value, filter.sort == e.key, () => filter.sort = e.key)]),
        group('状态', [
          FilterChip(label: const Text('进行中'), selected: filter.live, onSelected: (v) => pick(() => filter.live = v)),
          FilterChip(label: const Text('置顶'), selected: filter.pinned, onSelected: (v) => pick(() => filter.pinned = v)),
        ]),
        group('来源', [choice('全部', filter.channel == null, () => filter.channel = null), for (final e in sessionChannels.entries) choice(e.value, filter.channel == e.key, () => filter.channel = e.key)]),
        group('时间', [choice('全部', filter.range == null, () => filter.range = null), for (final e in sessionRanges.entries) choice(e.value, filter.range == e.key, () => filter.range = e.key)]),
        if (projectStore.supported)
          group('项目', [
            choice('全部', filter.project == null, () => filter.project = null),
            choice('不属于项目', filter.project == 'none', () => filter.project = 'none'),
            for (final p in projectStore.active) choice('${p['name']}', filter.project == p['id'], () => filter.project = '${p['id']}'),
          ]),
      ]);
    }), initial: 0.7, maxWidth: 520);
  }

  String _filterSummary() {
    final parts = <String>[
      if (filter.live) '进行中',
      if (filter.pinned) '置顶',
      if (filter.channel != null) sessionChannels[filter.channel] ?? filter.channel!,
      if (filter.range != null) sessionRanges[filter.range]!,
      if (filter.project == 'none') '不属于项目' else if (filter.project != null) '项目「${projectStore.byId(filter.project)?['name'] ?? '…'}」',
    ];
    return parts.join(' · ');
  }

  // ---------- 界面
  Widget _tile(Map s, ColorScheme cs, bool desktop, {bool showProject = true}) {
    final live = running.contains(s['id']), cur = s['id'] == widget.current;
    final pinned = ((s['pinned'] as num?) ?? 0) > 0;
    final p = projectStore.byId(s['project'] as String?);
    final small = desktop ? 18.0 : null;
    return ListTile(
      key: ValueKey('session-${s['id']}'),
      selected: cur,
      dense: desktop,
      leading: live
          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
          : p != null ? Icon(projectIcon(p), size: small, color: projectColor(p, cs)) : Icon(Icons.chat_bubble_outline, size: small, color: cs.outline),
      title: Row(children: [
        Expanded(child: Text('${s['title']}', maxLines: 1, overflow: TextOverflow.ellipsis)),
        if (pinned) Padding(padding: const EdgeInsets.only(left: 4), child: Icon(Icons.push_pin, size: 14, color: cs.primary, semanticLabel: '已置顶')),
      ]),
      subtitle: Text('${live ? '进行中 · ' : ''}${hm(s['updated'])} · ${s['count'] ?? 0} 条${showProject && p != null ? ' · ${p['name']}' : ''}${'${s['last'] ?? ''}'.isEmpty ? '' : '\n${plainPreview('${s['last']}')}'}', maxLines: 2, overflow: TextOverflow.ellipsis),
      isThreeLine: '${s['last'] ?? ''}'.isNotEmpty,
      onTap: () => _open(s),
      trailing: PopupMenuButton<String>(
        iconSize: small,
        onSelected: (v) => switch (v) { 'rename' => _rename(s), 'pin' => _pin(s), 'move' => _move(s), _ => _archive(s, v == 'archive') },
        itemBuilder: (_) => [
          PopupMenuItem(value: 'pin', child: Text(pinned ? '取消置顶' : '置顶')),
          if (projectStore.supported) PopupMenuItem(value: 'move', child: Text(p == null ? '移到项目…' : '换个项目…')),
          const PopupMenuItem(value: 'rename', child: Text('重命名')),
          PopupMenuItem(value: s['archived'] == true ? 'restore' : 'archive', child: Text(s['archived'] == true ? '找回' : '归档')),
        ],
      ),
    );
  }

  Widget _hitTile(Map h, ColorScheme cs, TextTheme tt, bool desktop) {
    final s = h['session'] as Map, hit = h['hit'] as Map?;
    final mark = TextStyle(fontWeight: FontWeight.bold, color: cs.primary, backgroundColor: cs.primary.withValues(alpha: 0.12));
    final p = projectStore.byId(s['project'] as String?);
    final more = ((h['matches'] as num?) ?? 0).toInt();
    return ListTile(
      key: ValueKey('hit-${s['id']}'),
      dense: desktop,
      selected: s['id'] == widget.current,
      leading: Icon(hit == null ? Icons.title : Icons.manage_search, size: desktop ? 18 : null, color: p != null ? projectColor(p, cs) : cs.outline),
      title: Text.rich(TextSpan(children: highlightSpans('${s['title']}', (h['titleMarks'] as List?) ?? const [], mark)), maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (hit != null) Text.rich(TextSpan(children: highlightSpans('${hit['snippet']}', (hit['marks'] as List?) ?? const [], mark)), maxLines: 2, overflow: TextOverflow.ellipsis),
        Text([hm((hit?['ts'] ?? s['updated']) as num), if (more > 1) '$more 处匹配', if (p != null) '${p['name']}', if (s['archived'] == true) '已归档'].join(' · '), style: tt.labelSmall?.copyWith(color: cs.outline)),
      ]),
      onTap: () => _openHit(h),
    );
  }

  Widget _groupHeader(String title, Map? p, int n, ColorScheme cs, TextTheme tt) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 2),
        child: Row(children: [
          if (p != null) Padding(padding: const EdgeInsets.only(right: 6), child: Icon(projectIcon(p), size: 16, color: projectColor(p, cs))),
          if (title == '置顶') Padding(padding: const EdgeInsets.only(right: 6), child: Icon(Icons.push_pin_outlined, size: 16, color: cs.primary)),
          Expanded(child: Text('$title  $n', style: tt.labelMedium?.copyWith(color: cs.onSurfaceVariant))),
          if (p != null) IconButton(tooltip: '只看这个项目', visualDensity: VisualDensity.compact, iconSize: 16, icon: const Icon(Icons.filter_alt_outlined), onPressed: () { setState(() { filter.project = '${p['id']}'; grouped = false; }); _load(); }),
          if (p != null) IconButton(tooltip: '编辑项目', visualDensity: VisualDensity.compact, iconSize: 16, icon: const Icon(Icons.edit_outlined), onPressed: () => editProject(context, project: p)),
        ]),
      );

  /// 搜索框与工具按钮（筛选、分组、项目）。
  Widget _toolbar(ColorScheme cs, bool desktop) {
    final hasProjects = projectStore.supported;
    return Padding(
      padding: EdgeInsets.fromLTRB(desktop ? 12 : 12, 6, 6, 4),
      child: Row(children: [
        Expanded(child: SizedBox(
          height: 38,
          child: TextField(
            key: const ValueKey('session-search'),
            controller: query,
            onChanged: _onQuery,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _load(),
            style: const TextStyle(fontSize: 14),
            decoration: InputDecoration(
              isDense: true, filled: true, fillColor: cs.surfaceContainerHigh,
              hintText: '搜索会话（标题与内容）',
              prefixIcon: const Icon(Icons.search, size: 18),
              suffixIcon: searching ? IconButton(tooltip: '清除', iconSize: 16, icon: const Icon(Icons.close), onPressed: () { query.clear(); _onQuery(''); }) : null,
              contentPadding: const EdgeInsets.symmetric(vertical: 8),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(19), borderSide: BorderSide.none),
            ),
          ),
        )),
        IconButton(
          tooltip: '筛选与排序', iconSize: 20, visualDensity: VisualDensity.compact,
          icon: Badge(isLabelVisible: filter.active || filter.sort != 'updated', smallSize: 7, child: const Icon(Icons.filter_list)),
          onPressed: _filters,
        ),
        if (hasProjects)
          IconButton(tooltip: grouped ? '不分组' : '按项目分组', iconSize: 20, visualDensity: VisualDensity.compact, isSelected: grouped,
              icon: Icon(grouped ? Icons.folder_copy : Icons.folder_copy_outlined), onPressed: () => setState(() => grouped = !grouped)),
        if (hasProjects)
          IconButton(tooltip: '管理项目', iconSize: 20, visualDensity: VisualDensity.compact, icon: const Icon(Icons.create_new_folder_outlined), onPressed: () => showProjectManager(context)),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme, tt = Theme.of(context).textTheme;
    final desktop = ShellScope.isDesktop(context);
    final pad = EdgeInsets.only(bottom: widget.framed ? 96 : 24);
    Widget empty(String t) => ListView(children: [Padding(padding: const EdgeInsets.all(48), child: Text(t, textAlign: TextAlign.center, style: TextStyle(color: cs.outline)))]);
    final Widget list;
    if (hits != null && searching) {
      list = hits!.isEmpty
          ? empty(searchError ?? '没有找到「${query.text.trim()}」')
          : ListView.builder(padding: pad, itemCount: hits!.length, itemBuilder: (_, i) => _hitTile(hits![i], cs, tt, desktop));
    } else if (sessions.isEmpty) {
      list = empty(filter.active ? '没有符合筛选的会话' : archived ? '没有归档的会话' : '还没有会话');
    } else if (grouped && filter.project == null && projectStore.supported) {
      final groups = groupSessions(sessions, projectStore);
      list = ListView(padding: pad, children: [
        for (final g in groups) ...[
          if (g.title.isNotEmpty) _groupHeader(g.title, g.project, g.items.length, cs, tt),
          for (final s in g.items) _tile(s, cs, desktop, showProject: g.key == 'pinned'),
        ],
      ]);
    } else {
      list = ListView.builder(padding: pad, itemCount: sessions.length, itemBuilder: (_, i) => _tile(sessions[i], cs, desktop, showProject: filter.project == null));
    }
    final summary = searching ? '' : _filterSummary();
    final body = Column(children: [
      _toolbar(cs, desktop),
      if (summary.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 8, 2),
          child: Row(children: [
            Expanded(child: Text('筛选：$summary', maxLines: 1, overflow: TextOverflow.ellipsis, style: tt.labelSmall?.copyWith(color: cs.primary))),
            TextButton(onPressed: () { setState(filter.clear); _load(); }, child: const Text('清除')),
          ]),
        ),
      Expanded(child: RefreshIndicator(onRefresh: _load, child: list)),
    ]);
    if (!widget.framed) {
      // 桌面列表栏：顶部一行「会话 · 新建 · 已归档」，下面是搜索框与筛选
      return Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 6, 2),
          child: Row(children: [
            Expanded(child: Text(archived ? '已归档' : '会话', style: tt.labelLarge?.copyWith(color: cs.onSurfaceVariant))),
            IconButton(tooltip: archived ? '返回会话' : '已归档', iconSize: 18, visualDensity: VisualDensity.compact, icon: Icon(archived ? Icons.forum_outlined : Icons.inventory_2_outlined), onPressed: () { setState(() => archived = !archived); _load(); }),
            if (!archived) IconButton(tooltip: '新会话', iconSize: 18, visualDensity: VisualDensity.compact, icon: const Icon(Icons.add_comment_outlined), onPressed: _new),
          ]),
        ),
        Expanded(child: body),
      ]);
    }
    return PageFrame(
      title: archived ? '已归档的会话' : '会话',
      actions: [IconButton(tooltip: archived ? '返回会话' : '已归档', icon: Icon(archived ? Icons.forum : Icons.inventory_2_outlined), onPressed: () { setState(() => archived = !archived); _load(); })],
      fab: archived ? null : FloatingActionButton.extended(onPressed: _new, icon: const Icon(Icons.add_comment), label: const Text('新会话')),
      body: body,
    );
  }
}
