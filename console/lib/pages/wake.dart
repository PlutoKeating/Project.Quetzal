// 醒来记录：她自己醒来思考 / 做梦 / 被叫醒（以及某一次对话）的完整过程，只读。
//   显示的内容与对话页一致：工具卡片（点开看参数与结果）、中途说的话、正在写的文字，结束后是日记与心情；但没有输入框——这是她自己的时间，你只能看。
//   两种来源：进行中的一轮（sessions.live 快照 + activity 推送增量更新，结束后自动接上时间线里保存的记录），以及时间线里已经保存的一条记录。
//   WakeWatch 在整个 App 里跟踪进行中的非对话轮次（醒来思考 / 做梦），首页与心流页据此显示「她正在想…」的入口。
import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../process.dart';
import '../widgets.dart';

const wakeKinds = {'think': ('思考', Icons.psychology), 'dream': ('梦', Icons.nights_stay), 'doze': ('小憩', Icons.snooze), 'chat': ('对话', Icons.chat)};

/// 跟踪进行中的醒来（origin 为 think / dream 的轮次）。在线时从后端取快照，之后随 activity 事件更新。
class WakeWatch extends ChangeNotifier {
  final turns = <String, LiveTurn>{};
  bool _wasOnline = false;

  void start() {
    api.events.listen(_onEvent);
    api.addListener(_onConn);
  }

  void _onConn() {
    final online = api.conn == Conn.online;
    if (online && !_wasOnline) reload();
    if (!online && turns.isNotEmpty) { turns.clear(); notifyListeners(); }
    _wasOnline = online;
  }

  Future<void> reload() async {
    try {
      final l = await api.call<List>('sessions.live');
      turns
        ..clear()
        ..addEntries(l.cast<Map>().where((t) => t['origin'] != 'chat').map((t) => MapEntry('${t['turn']}', LiveTurn.snapshot(t))));
      notifyListeners();
    } catch (_) {}
  }

  void _onEvent(GatewayEvent e) {
    if (e.name != 'activity') return;
    final a = e.data as Map;
    if (a['origin'] == 'chat') return;
    final id = '${a['session']}';
    switch (a['kind']) {
      case 'start': turns[id] = LiveTurn(id, 0, '${a['text'] ?? ''}', origin: '${a['origin']}');
      case 'done' || 'error': turns.remove(id);
      case 'alive': return;
      default:
        final t = turns[id];
        if (t == null) { reload(); return; } // 错过了开头：取快照
        t.apply(a);
    }
    notifyListeners();
  }

  List<LiveTurn> get list => turns.values.toList();
}

final wakes = WakeWatch();

/// 首页与心流页的入口：她正在思考 / 做梦时出现，点开只读地看她在做什么。
class LiveWakeTile extends StatelessWidget {
  final LiveTurn t;
  const LiveWakeTile(this.t, {super.key});
  @override
  Widget build(BuildContext context) => Card(
        child: ListTile(
          leading: const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2)),
          title: Text(t.origin == 'dream' ? '她在做梦…' : t.origin == 'agent' ? '她派出的子 agent 在工作…' : '她醒着，在想事情…'),
          subtitle: Text('${describeTurn(t)}\n${plainPreview(t.text)}', maxLines: 2, overflow: TextOverflow.ellipsis),
          trailing: const Icon(Icons.visibility_outlined),
          onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WakePage(turn: t.id))),
        ),
      );
}

/// 只读的过程页。entry：时间线里已保存的记录；turn：进行中的一轮的标识（二者给一个）。
class WakePage extends StatefulWidget {
  final Map? entry;
  final String? turn;
  const WakePage({super.key, this.entry, this.turn}) : assert(entry != null || turn != null);
  @override
  State<WakePage> createState() => _WakePageState();
}

class _WakePageState extends State<WakePage> {
  Map? entry;
  LiveTurn? live;
  bool finished = false, missing = false;
  String? error;
  int started = 0;
  final subs = <StreamSubscription>[];
  late final AppLifecycleListener life;
  bool wasOnline = true;

  @override
  void initState() {
    super.initState();
    entry = widget.entry;
    if (widget.turn != null) {
      started = DateTime.now().millisecondsSinceEpoch;
      live = wakes.turns[widget.turn!];
      subs.add(api.events.where((e) => e.name == 'activity').listen(_onActivity));
      subs.add(api.events.where((e) => e.name == 'timeline').listen(_onTimeline));
      api.addListener(_onConn);
      life = AppLifecycleListener(onResume: () async { await api.ensureAlive(); _resync(); });
      _resync();
    }
  }

  @override
  void dispose() {
    for (final s in subs) { s.cancel(); }
    if (widget.turn != null) { api.removeListener(_onConn); life.dispose(); }
    super.dispose();
  }

  void _onConn() {
    final online = api.conn == Conn.online;
    if (online && !wasOnline) _resync();
    wasOnline = online;
  }

  /// 从后端取快照重建（打开、重连、从后台切回）。快照里没有了：说明已经结束，去时间线里找保存的记录。
  Future<void> _resync() async {
    if (finished) return;
    try {
      final l = await api.call<List>('sessions.live');
      final t = l.cast<Map>().where((t) => '${t['turn']}' == widget.turn).firstOrNull;
      if (!mounted) return;
      if (t != null) { setState(() => live = LiveTurn.snapshot(t)); return; }
      final tl = await api.call<List>('timeline', {'limit': 10});
      if (!mounted) return;
      final saved = tl.cast<Map>().where((e) => const ['think', 'dream'].contains(e['kind']) && (e['ts'] as num) >= started - 60000).firstOrNull; // 记录在结束时写入，一定晚于打开这一页
      setState(() { finished = true; if (saved != null) { entry = saved; } else if (live == null) { missing = true; } });
    } catch (_) {}
  }

  void _onActivity(GatewayEvent e) {
    final a = e.data as Map;
    if ('${a['session']}' != widget.turn || !mounted) return;
    setState(() {
      switch (a['kind']) {
        case 'start': live = LiveTurn(widget.turn!, 0, '${a['text'] ?? ''}', origin: '${a['origin']}');
        case 'done': finished = true;
        case 'error': finished = true; error = '${a['message'] ?? ''}';
        case 'alive': break;
        default: (live ??= LiveTurn(widget.turn!, 0, '', origin: '${a['origin']}')).apply(a);
      }
    });
  }

  /// 结束后，这次醒来的记录写进时间线：接上，显示日记与心情。
  void _onTimeline(GatewayEvent e) {
    final t = e.data as Map;
    if (entry != null || !mounted || !const ['think', 'dream'].contains(t['kind'])) return;
    if (!finished && live != null) return; // 别的醒来（不太可能同时有两个，但以防万一）
    setState(() { entry = t; finished = true; });
  }

  @override
  Widget build(BuildContext context) {
    final e = entry, d = (e?['detail'] as Map?) ?? {}, t = live;
    final kind = '${e?['kind'] ?? (t?.origin == 'dream' ? 'dream' : t?.origin == 'agent' ? 'agent' : 'think')}';
    final k = wakeKinds[kind] ?? (kind, Icons.circle);
    final cs = Theme.of(context).colorScheme, tt = Theme.of(context).textTheme;
    final items = (d['process'] as List?)?.cast<Map>() ?? (t?.items ?? itemsFromSteps((d['steps'] as List?) ?? []));
    final steps = (d['steps'] as List?)?.cast<Map>() ?? const [];
    final reason = '${d['reason'] ?? t?.text ?? ''}';
    return Scaffold(
      appBar: AppBar(
        title: Text(e != null ? '${e['title']}' : (t?.origin == 'dream' ? '她在做梦' : t?.origin == 'agent' ? '子 agent 在工作' : '她在想事情'), maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [Padding(padding: const EdgeInsets.only(right: 12), child: Center(child: Chip(avatar: Icon(k.$2, size: 16), label: Text(k.$1), visualDensity: VisualDensity.compact)))],
      ),
      body: Column(children: [
        Expanded(
          child: ListView(padding: const EdgeInsets.all(12), children: [
            if (missing) const Padding(padding: EdgeInsets.all(32), child: Text('这一轮已经结束，没有找到保存的记录。', textAlign: TextAlign.center)),
            // 缘起：为什么醒来、想做什么（对话则是对方说的话）
            if (kind == 'chat' && d['text'] != null) Align(alignment: Alignment.centerRight, child: Bubble('${d['text']}', me: true, channel: d['channel']))
            else if (reason.isNotEmpty || d['intent'] != null)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    if (reason.isNotEmpty) Text('因为：$reason', style: tt.bodySmall),
                    if ('${d['intent'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('想：${d['intent']}', style: tt.bodySmall)),
                    if (e != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${hm(e['ts'])}${d['model'] != null && '${d['model']}'.isNotEmpty ? ' · ${d['model']}' : ''}${d['tokens'] != null ? ' · ${d['tokens']} tokens' : ''}', style: tt.labelSmall?.copyWith(color: cs.outline))),
                  ]),
                ),
              ),
            // 过程：工具卡片与中途说的话，与对话页一致
            if (items.isNotEmpty) ProcessView(items, steps: steps),
            if (t != null && !finished && t.live.isNotEmpty) Bubble(t.live, live: true),
            if (t != null && !finished && t.hint.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(t.hint, style: TextStyle(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic))),
            if (t != null && finished && e == null && t.live.isNotEmpty) Bubble(t.live),
            if (t != null && finished && e == null && error == null && !missing) Padding(padding: const EdgeInsets.all(8), child: Text('结束了，正在等她把日记写好…', style: TextStyle(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic))),
            if (error != null || d['error'] != null) Padding(padding: const EdgeInsets.all(8), child: Text('中断了：${error ?? d['error']}', style: TextStyle(color: cs.error))),
            // 结果：对话的回复，或醒来后写下的日记与心情
            if (kind == 'chat' && d['reply'] != null) Bubble('${d['reply']}'),
            if (d['journal'] != null) Section(kind == 'dream' ? '梦的记录' : '日记', [RichMarkdown('${d['journal']}')]),
            if ('${d['feeling'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: Text('心情：${d['feeling']}', style: tt.bodySmall)),
            if ('${d['thought'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.all(12), child: RichMarkdown('想和你分享：${d['thought']}')),
            const SizedBox(height: 24),
          ]),
        ),
        // 只读：没有输入框。她自己的时间只能看，不能插话；想说话去「聊天」。
        SafeArea(
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            color: cs.surfaceContainer,
            child: Row(children: [
              Icon(Icons.visibility_outlined, size: 16, color: cs.outline),
              const SizedBox(width: 8),
              Expanded(child: Text(kind == 'chat' ? '这是一次对话的记录，只读。要继续说话，去这个会话里。' : '这是她自己的时间：只能看，不能插话。想说话，去首页「聊天」。', style: tt.bodySmall?.copyWith(color: cs.outline))),
            ]),
          ),
        ),
      ]),
    );
  }
}
