// 对话：与她说话；她主动说的话也会出现在这里。她的回复按完整 Markdown 渲染（表格、公式、Mermaid 图等，见 markdown.dart）。
// 她回应时实时显示过程：流式文字，以及每个工具执行时 / 执行后的单行卡片。
// 等待回复不设绝对超时：只要基座还有进展（流式文字、工具、心跳）就一直等，120 秒毫无动静才判定超时；
// 超时或断线后，回复一到（done 推送）或重连后重新拉取记录，都会补上。
import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';
import '../markdown.dart';

/// 正在进行的一次回应。
class _Turn {
  final String session;
  final items = <Map>[]; // {type: tool, call, name, summary, status, ms} | {type: text, text}
  String live = '';
  bool queued = false, lost = false;
  _Turn(this.session);
}

class ChatPage extends StatefulWidget {
  const ChatPage({super.key});
  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final msgs = <Map>[];
  final input = TextEditingController();
  final scroll = ScrollController();
  final subs = <StreamSubscription>[];
  _Turn? turn;
  bool wasOnline = true;

  @override
  void initState() {
    super.initState();
    _load();
    subs.add(api.events.where((e) => e.name == 'say').listen((e) { if (mounted) setState(() => msgs.add({'role': 'agent', 'channel': '主动', 'text': e.data, 'ts': DateTime.now().millisecondsSinceEpoch})); }));
    subs.add(api.events.where((e) => e.name == 'activity').listen(_onActivity));
    api.addListener(_onConn);
  }

  @override
  void dispose() {
    for (final s in subs) { s.cancel(); }
    api.removeListener(_onConn);
    super.dispose();
  }

  void _load() => api.call<List>('messages', {'limit': 60}).then((l) { if (mounted) setState(() => msgs..clear()..addAll(l.cast<Map>())); _bottom(); }).catchError((_) {});

  // 断线重连后，若有回复在断线期间丢失，重新拉取对话记录补上
  void _onConn() {
    final online = api.conn == Conn.online;
    if (online && !wasOnline && turn != null && turn!.lost) _load();
    wasOnline = online;
  }

  void _onActivity(GatewayEvent e) {
    final a = e.data as Map, t = turn;
    if (t == null || a['session'] != t.session || !mounted) return;
    setState(() {
      switch (a['kind']) {
        case 'queued': t.queued = true;
        case 'step': t.queued = false;
        case 'delta': t.live += '${a['text'] ?? ''}';
        case 'text':
          final text = '${a['text'] ?? ''}'.trim();
          if (a['final'] == true) { t.live = text; } else { if (text.isNotEmpty) t.items.add({'type': 'text', 'text': text}); t.live = ''; }
        case 'tool':
          final i = t.items.indexWhere((x) => x['type'] == 'tool' && x['call'] == a['call']);
          final item = {'type': 'tool', ...a};
          if (i >= 0) { t.items[i] = item; } else { t.items.add(item); }
        case 'done' || 'error':
          _finish(t, '${a['reply'] ?? a['message'] ?? '……'}');
      }
    });
    _bottom();
  }

  void _finish(_Turn t, String reply) {
    if (turn != t) return;
    msgs.add({'role': 'agent', 'channel': '控制台', 'text': reply, 'process': List<Map>.from(t.items)});
    turn = null;
  }

  Future<void> _send() async {
    final text = input.text.trim();
    if (text.isEmpty || !_idle) return;
    input.clear();
    final t = _Turn('${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}${Random().nextInt(1 << 30).toRadixString(36)}');
    setState(() { msgs.add({'role': 'user', 'channel': '控制台', 'text': text}); turn = t; });
    _bottom();
    try {
      final r = await api.callLive<String>('chat.send', {'text': text, 'session': t.session},
          isProgress: (e) => e.name == 'activity' && (e.data as Map)['session'] == t.session);
      if (mounted) setState(() => _finish(t, r));
    } catch (e) {
      if (!mounted) return;
      toast(context, '$e');
      setState(() => t.lost = true); // 仍等待 done 推送或重连后补上
    }
    _bottom();
  }

  bool get _idle => turn == null || turn!.lost; // 丢失连接的那次回应不阻塞新的对话

  Future<void> _bottom() async {
    await Future.delayed(const Duration(milliseconds: 50));
    if (scroll.hasClients) scroll.jumpTo(scroll.position.maxScrollExtent);
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final t = turn;
    return Scaffold(
      appBar: AppBar(title: Text('和${api.name}说话')),
      body: Column(children: [
        Expanded(
          child: ListView.builder(
            controller: scroll,
            padding: const EdgeInsets.all(12),
            itemCount: msgs.length + (t != null ? 1 : 0),
            itemBuilder: (_, i) {
              if (i == msgs.length) return _live(t!, cs);
              final m = msgs[i], me = m['role'] == 'user';
              final process = (m['process'] as List?)?.cast<Map>() ?? const [];
              return Column(crossAxisAlignment: me ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
                if (process.isNotEmpty) _Process(process),
                _bubble(context, '${m['text']}', me, cs, channel: m['channel']),
              ]);
            },
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Row(children: [
              Expanded(child: TextField(controller: input, minLines: 1, maxLines: 4, decoration: const InputDecoration(hintText: '说点什么', border: OutlineInputBorder()), onSubmitted: (_) => _send())),
              IconButton.filled(onPressed: _idle ? _send : null, icon: const Icon(Icons.send)),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _live(_Turn t, ColorScheme cs) {
    final running = t.items.any((x) => x['type'] == 'tool' && x['status'] == 'running');
    final hint = t.lost ? '连接中断：回复生成后会自动补上' : t.queued ? '排队中…' : running ? '正在调用工具…' : t.live.isEmpty ? '她在想…' : '';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (t.items.isNotEmpty) _Process(t.items),
      if (t.live.isNotEmpty) _bubble(context, t.live, false, cs, live: true),
      if (hint.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(hint, style: TextStyle(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic))),
    ]);
  }

  Widget _bubble(BuildContext context, String text, bool me, ColorScheme cs, {Object? channel, bool live = false}) => Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
        decoration: BoxDecoration(color: me ? cs.primaryContainer : cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          me ? SelectableText(text) : RichMarkdown(text, live: live),
          if (channel != null && channel != '控制台') Text('$channel', style: Theme.of(context).textTheme.labelSmall),
        ]),
      );
}

/// 执行过程：每个工具一行（执行中 / 完成 / 出错 / 被拒绝），中间叙述一行。
class _Process extends StatelessWidget {
  final List<Map> items;
  const _Process(this.items);

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final small = Theme.of(context).textTheme.bodySmall;
    return Container(
      margin: const EdgeInsets.only(top: 4),
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.9),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final x in items)
          Container(
            margin: const EdgeInsets.symmetric(vertical: 2),
            padding: const EdgeInsets.only(left: 8),
            decoration: BoxDecoration(border: Border(left: BorderSide(color: cs.outlineVariant, width: 2))),
            child: x['type'] == 'text'
                ? Text('${x['text']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: small?.copyWith(color: cs.onSurfaceVariant))
                : Row(children: [
                    _icon(x['status'], cs),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text.rich(
                        TextSpan(children: [
                          TextSpan(text: '${x['name']}', style: const TextStyle(fontWeight: FontWeight.bold)),
                          if ('${x['summary'] ?? ''}'.isNotEmpty) TextSpan(text: ' — ${x['summary']}', style: TextStyle(color: cs.onSurfaceVariant)),
                        ]),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: small,
                      ),
                    ),
                    if (x['ms'] != null && x['status'] != 'running') Text('  ${((x['ms'] as num) / 1000).toStringAsFixed(1)}s', style: small?.copyWith(color: cs.outline)),
                  ]),
          ),
      ]),
    );
  }

  Widget _icon(Object? status, ColorScheme cs) => switch (status) {
        'running' => const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
        'ok' => const Icon(Icons.check_circle, size: 16, color: Colors.green),
        'denied' => Icon(Icons.block, size: 16, color: cs.outline),
        _ => Icon(Icons.error, size: 16, color: cs.error),
      };
}
