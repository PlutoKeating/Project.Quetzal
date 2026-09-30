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

class SessionsPage extends StatefulWidget {
  final String? current;
  const SessionsPage({super.key, this.current});
  @override
  State<SessionsPage> createState() => _SessionsPageState();
}

class _SessionsPageState extends State<SessionsPage> {
  List<Map> sessions = [];
  Set<String> running = {};
  bool archived = false;
  StreamSubscription? sub;

  @override
  void initState() {
    super.initState();
    _load();
    sub = api.events.where((e) => e.name == 'activity' && const ['start', 'done', 'error'].contains((e.data as Map)['kind'])).listen((_) => _load());
  }

  @override
  void dispose() { sub?.cancel(); super.dispose(); }

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

  void _open(Map s) => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ChatPage(conv: '${s['id']}', title: '${s['title']}')));

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
    return Scaffold(
      appBar: AppBar(title: Text(archived ? '已归档的会话' : '会话'), actions: [
        IconButton(tooltip: archived ? '返回会话' : '已归档', icon: Icon(archived ? Icons.forum : Icons.inventory_2_outlined), onPressed: () { setState(() => archived = !archived); _load(); }),
      ]),
      floatingActionButton: archived ? null : FloatingActionButton.extended(onPressed: _new, icon: const Icon(Icons.add_comment), label: const Text('新会话')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: sessions.isEmpty
            ? ListView(children: [Padding(padding: const EdgeInsets.all(48), child: Text(archived ? '没有归档的会话' : '还没有会话', textAlign: TextAlign.center))])
            : ListView.builder(
                padding: const EdgeInsets.only(bottom: 96),
                itemCount: sessions.length,
                itemBuilder: (_, i) {
                  final s = sessions[i], live = running.contains(s['id']), cur = s['id'] == widget.current;
                  return ListTile(
                    selected: cur,
                    leading: live ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)) : Icon(Icons.chat_bubble_outline, color: cs.outline),
                    title: Text('${s['title']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${live ? '进行中 · ' : ''}${hm(s['updated'])} · ${s['count']} 条${'${s['last'] ?? ''}'.isEmpty ? '' : '\n${plainPreview('${s['last']}')}'}', maxLines: 2, overflow: TextOverflow.ellipsis),
                    isThreeLine: '${s['last'] ?? ''}'.isNotEmpty,
                    onTap: () => _open(s),
                    trailing: PopupMenuButton<String>(
                      onSelected: (v) => v == 'rename' ? _rename(s) : _archive(s, v == 'archive'),
                      itemBuilder: (_) => [
                        const PopupMenuItem(value: 'rename', child: Text('重命名')),
                        PopupMenuItem(value: archived ? 'restore' : 'archive', child: Text(archived ? '找回' : '归档')),
                      ],
                    ),
                  );
                },
              ),
      ),
    );
  }
}
