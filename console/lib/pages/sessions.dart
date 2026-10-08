// 会话：多个会话可以同时进行；每个会话都能看到其他会话（后端在系统提示里提供），不是彼此隔离的。
// 这里管理会话：新建、打开、重命名、归档；「已归档」里可以找回。正在进行的会话带有标记。
import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import 'chat.dart';

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

/// 会话列表：新建、打开、重命名、归档与找回。framed：手机上套 AppBar 与新建按钮；桌面列表栏里直接用。
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
  Set<String> running = {};
  bool archived = false;
  StreamSubscription? sub;

  @override
  void initState() {
    super.initState();
    _wasOnline = api.conn == Conn.online;
    _load();
    sub = api.events.where((e) => (e.name == 'activity' && const ['start', 'done', 'error'].contains((e.data as Map)['kind'])) || e.name == 'session.switch' || e.name == 'say' || e.name == 'replica').listen((_) => _load()); // replica：其他身体的对话到了
    api.addListener(_onConn);
  }

  bool _wasOnline = false; // 初值在 initState 里按此刻的连接状态设：创建时还没连上，连上那一刻就要重新加载
  void _onConn() { final on = api.conn == Conn.online; if (on && !_wasOnline) _load(); _wasOnline = on; }

  @override
  void dispose() { sub?.cancel(); api.removeListener(_onConn); super.dispose(); }

  /// 外部（桌面外壳）要求刷新。
  void reload() => _load();

  Future<void> _load() async {
    try {
      final r = await Future.wait([api.call<List>('sessions', {'archived': archived}), api.call<List>('sessions.live')]);
      if (!mounted) return;
      setState(() {
        sessions = r[0].cast<Map>();
        running = r[1].cast<Map>().map((t) => '${t['conv']}').toSet();
      });
    } catch (_) {}
  }

  void _open(Map s) => widget.onOpen(s);

  Future<void> _new() async {
    final s = await act(context, () => api.call<Map>('sessions.create'));
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

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final desktop = ShellScope.isDesktop(context);
    final list = sessions.isEmpty
        ? ListView(children: [Padding(padding: const EdgeInsets.all(48), child: Text(archived ? '没有归档的会话' : '还没有会话', textAlign: TextAlign.center, style: TextStyle(color: cs.outline)))])
        : ListView.builder(
            padding: EdgeInsets.only(bottom: widget.framed ? 96 : 24),
            itemCount: sessions.length,
            itemBuilder: (_, i) {
              final s = sessions[i], live = running.contains(s['id']), cur = s['id'] == widget.current;
              return ListTile(
                selected: cur,
                dense: desktop,
                leading: live ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : Icon(Icons.chat_bubble_outline, size: desktop ? 18 : null, color: cs.outline),
                title: Text('${s['title']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text('${live ? '进行中 · ' : ''}${hm(s['updated'])} · ${s['count']} 条${'${s['last'] ?? ''}'.isEmpty ? '' : '\n${plainPreview('${s['last']}')}'}', maxLines: 2, overflow: TextOverflow.ellipsis),
                isThreeLine: '${s['last'] ?? ''}'.isNotEmpty,
                onTap: () => _open(s),
                trailing: PopupMenuButton<String>(
                  iconSize: desktop ? 18 : null,
                  onSelected: (v) => v == 'rename' ? _rename(s) : _archive(s, v == 'archive'),
                  itemBuilder: (_) => [
                    const PopupMenuItem(value: 'rename', child: Text('重命名')),
                    PopupMenuItem(value: archived ? 'restore' : 'archive', child: Text(archived ? '找回' : '归档')),
                  ],
                ),
              );
            },
          );
    if (!widget.framed) {
      // 桌面列表栏：顶部一行「会话 · 新建 · 已归档」
      return Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 6, 2),
          child: Row(children: [
            Expanded(child: Text(archived ? '已归档' : '会话', style: Theme.of(context).textTheme.labelLarge?.copyWith(color: cs.onSurfaceVariant))),
            IconButton(tooltip: archived ? '返回会话' : '已归档', iconSize: 18, visualDensity: VisualDensity.compact, icon: Icon(archived ? Icons.forum_outlined : Icons.inventory_2_outlined), onPressed: () { setState(() => archived = !archived); _load(); }),
            if (!archived) IconButton(tooltip: '新会话', iconSize: 18, visualDensity: VisualDensity.compact, icon: const Icon(Icons.add_comment_outlined), onPressed: _new),
          ]),
        ),
        Expanded(child: list),
      ]);
    }
    return PageFrame(
      title: archived ? '已归档的会话' : '会话',
      actions: [IconButton(tooltip: archived ? '返回会话' : '已归档', icon: Icon(archived ? Icons.forum : Icons.inventory_2_outlined), onPressed: () { setState(() => archived = !archived); _load(); })],
      fab: archived ? null : FloatingActionButton.extended(onPressed: _new, icon: const Icon(Icons.add_comment), label: const Text('新会话')),
      body: RefreshIndicator(onRefresh: _load, child: list),
    );
  }
}
