// 对话：一个会话的完整界面。多个会话可以同时进行（见 sessions.dart），后端让每个会话都能看到其他会话。
//   后端是唯一的事实来源：打开页面、断线重连、从后台切回、每一轮结束时，都从后端取回对话记录与「进行中的轮次」快照重建界面，
//   期间的实时进展（流式文字、工具卡片）由 activity 推送增量更新。所以切到后台再回来，进行中的卡片会完整恢复并继续更新。
//   附件：一次最多 20 个文件，先上传到基座，再随消息发送（图片直接进消息，文本内联，文档给路径由她自己读）。
//   她工作时发消息：默认「插话」（这次模型调用结束后并入）；发送按钮右侧的小三角可改为「排队」（下一轮）或「打断」（立即中止当前模型输出，不打断工具）。
//   滚动：打开即在最底部；在底部时新内容自动跟随；上滑后右下角出现「回到底部」，有新内容时变亮并显示「新消息」。
import 'dart:async';
import 'dart:math';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';
import '../markdown.dart';
import 'sessions.dart';

const maxFiles = 20;
const modes = {'steer': ('插话', '这一步结束后并入，她会注意到', Icons.call_merge), 'queue': ('排队', '等这一轮结束后再处理', Icons.schedule_send), 'interrupt': ('打断', '立即打断她的输出，工具不受影响', Icons.pan_tool)};

/// 进行中的一轮（由后端快照与推送事件共同维护）。
class _Turn {
  final String id;
  int msg;
  String text, status = 'running', live = '';
  final items = <Map>[];
  _Turn(this.id, this.msg, this.text);
  factory _Turn.snapshot(Map t) => _Turn('${t['turn']}', (t['msg'] as num?)?.toInt() ?? 0, '${t['text'] ?? ''}')
    ..status = '${t['status'] ?? 'running'}'
    ..live = '${t['live'] ?? ''}'
    ..items.addAll((t['items'] as List? ?? []).cast<Map>());
}

/// 待发送的附件（上传中 / 已上传 / 失败）。
class _Pending {
  final String name;
  final int size;
  double progress = 0;
  Map? file;
  String? error;
  _Pending(this.name, this.size);
}

class ChatPage extends StatefulWidget {
  final String conv, title;
  const ChatPage({super.key, required this.conv, this.title = '对话'});
  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final msgs = <Map>[];
  final turns = <String, _Turn>{};
  final local = <String, Map>{}; // 刚发出、后端还没确认的话（turn → 消息）
  final finished = <String>{}; // 已结束的轮次：取回快照时忽略（防止与已入库的回复重复）
  final files = <_Pending>[];
  final input = TextEditingController();
  final scroll = ScrollController();
  final subs = <StreamSubscription>[];
  late final AppLifecycleListener life;
  String title = '';
  bool atBottom = true, unread = false, wasOnline = true, loading = true;
  String mode = 'steer'; // 她正在工作时发消息的方式
  double lastExtent = 0;

  @override
  void initState() {
    super.initState();
    title = widget.title;
    scroll.addListener(_onScroll);
    subs.add(api.events.where((e) => e.name == 'activity').listen(_onActivity));
    subs.add(api.events.where((e) => e.name == 'say').listen((_) { if (widget.conv == 'inbox') _resync(); }));
    api.addListener(_onConn);
    life = AppLifecycleListener(onResume: () async { await api.ensureAlive(); _resync(); }); // 从后台切回：确认连接并从后端重建
    _resync(first: true);
  }

  @override
  void dispose() {
    for (final s in subs) { s.cancel(); }
    api.removeListener(_onConn);
    life.dispose();
    super.dispose();
  }

  void _onConn() {
    final online = api.conn == Conn.online;
    if (online && !wasOnline) _resync(); // 重连后补上断线期间的一切
    wasOnline = online;
  }

  /// 从后端重建：对话记录 + 进行中的轮次快照。
  Future<void> _resync({bool first = false}) async {
    try {
      final r = await Future.wait([api.call<List>('sessions.messages', {'id': widget.conv, 'limit': 100}), api.call<List>('sessions.live'), api.call<List>('sessions')]);
      if (!mounted) return;
      final me = r[2].cast<Map>().where((s) => s['id'] == widget.conv);
      setState(() {
        msgs..clear()..addAll(r[0].cast<Map>());
        turns
          ..clear()
          ..addEntries(r[1].cast<Map>().where((t) => t['conv'] == widget.conv && t['origin'] == 'chat' && !finished.contains(t['turn'])).map((t) => MapEntry('${t['turn']}', _Turn.snapshot(t))));
        local.removeWhere((k, _) => turns.containsKey(k) || msgs.any((m) => m['role'] == 'user' && m['text'] == local[k]!['text']));
        if (me.isNotEmpty) title = '${me.first['title']}';
        loading = false;
      });
      _changed(force: first);
    } catch (_) {
      if (mounted) setState(() => loading = false);
    }
  }

  void _onActivity(GatewayEvent e) {
    final a = e.data as Map;
    if (a['conv'] != widget.conv || a['origin'] != 'chat' || !mounted) return;
    final id = '${a['session']}';
    switch (a['kind']) {
      case 'start':
        local.remove(id);
        turns[id] = _Turn(id, (a['msg'] as num?)?.toInt() ?? 0, '${a['text'] ?? ''}');
        _resync(); // 取回这句话（也可能来自另一个客户端）
        return;
      case 'steer':
        _resync(); // 这句话已并入进行中的一轮
        return;
      case 'done' || 'error':
        finished.add(id);
        turns.remove(id);
        _resync(); // 回复与执行过程已经存进记录
        return;
      case 'alive':
        return;
    }
    final t = turns[id];
    if (t == null) { _resync(); return; } // 错过了开头（例如刚切回前台）：直接取快照
    setState(() {
      switch (a['kind']) {
        case 'queued': t.status = 'queued';
        case 'step': t.status = 'running';
        case 'delta': t.live += '${a['text'] ?? ''}';
        case 'text':
          final text = '${a['text'] ?? ''}'.trim();
          if (a['final'] == true) { t.live = text; } else { if (text.isNotEmpty) t.items.add({'type': 'text', 'text': text}); t.live = ''; }
        case 'tool':
          final i = t.items.indexWhere((x) => x['type'] == 'tool' && x['call'] == a['call']);
          final item = {'type': 'tool', ...a};
          if (i >= 0) { t.items[i] = item; } else { t.items.add(item); }
      }
    });
    _changed();
  }

  // ---------- 滚动：在底部时跟随；不在底部时提示「新消息」
  void _onScroll() {
    if (!scroll.hasClients) return;
    final bottom = scroll.position.maxScrollExtent - scroll.position.pixels < 80;
    if (bottom != atBottom || (bottom && unread)) setState(() { atBottom = bottom; if (bottom) unread = false; });
  }

  void _changed({bool force = false}) {
    if (force || atBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _toBottom(animate: !force));
      if (force) Future.delayed(const Duration(milliseconds: 400), () => _toBottom(animate: false)); // 图表、公式渲染后高度会变
    } else if (!unread) {
      setState(() => unread = true);
    }
  }

  void _toBottom({bool animate = true}) {
    if (!scroll.hasClients) return;
    final end = scroll.position.maxScrollExtent;
    animate ? scroll.animateTo(end, duration: const Duration(milliseconds: 250), curve: Curves.easeOut) : scroll.jumpTo(end);
    if (unread || !atBottom) setState(() { unread = false; atBottom = true; });
  }

  // ---------- 附件
  Future<void> _pick() async {
    final room = maxFiles - files.length;
    if (room <= 0) { toast(context, '一次最多 $maxFiles 个文件'); return; }
    final r = await FilePicker.pickFiles();
    if (r.isEmpty || !mounted) return;
    final picked = r.take(room).toList();
    if (r.length > room) toast(context, '一次最多 $maxFiles 个文件，已取前 $room 个');
    for (final f in picked) {
      final size = await f.length() ?? 0;
      final p = _Pending(f.name, size);
      if (!mounted) return;
      setState(() => files.add(p));
      try {
        p.file = await api.upload(f.name, f.readAsByteStream(), size, onProgress: (v) { if (mounted) setState(() => p.progress = v); });
      } catch (e) {
        p.error = '$e';
      }
      if (mounted) setState(() {});
    }
  }

  bool get uploading => files.any((f) => f.file == null && f.error == null);

  Future<void> _send() async {
    final text = input.text.trim();
    final ready = files.where((f) => f.file != null).map((f) => f.file!).toList();
    if ((text.isEmpty && ready.isEmpty) || uploading) return;
    final turn = '${DateTime.now().microsecondsSinceEpoch.toRadixString(36)}${Random().nextInt(1 << 30).toRadixString(36)}';
    final how = turns.isEmpty ? null : mode;
    input.clear();
    setState(() {
      local[turn] = {'role': 'user', 'text': text, 'attachments': ready, 'pending': true, 'mode': ?how};
      files.clear();
      atBottom = true;
      mode = 'steer';
    });
    _changed(force: true);
    try {
      await api.callLive<String>('chat.send', {'conv': widget.conv, 'turn': turn, 'text': text, 'attachments': ready, 'mode': ?how},
          isProgress: (e) => e.name == 'activity' && (e.data as Map)['session'] == turn);
    } catch (e) {
      if (mounted && '$e'.contains('未连接')) toast(context, '$e');
      // 超时或断线：后端仍在工作，重连 / 切回前台时会从后端恢复
    }
  }

  // ---------- 界面
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    // 进行中的轮次挂在它对应的那句话下面；找不到时放在最后
    final after = <int, List<_Turn>>{};
    final tail = <_Turn>[];
    final ids = msgs.map((m) => (m['id'] as num?)?.toInt()).toSet();
    for (final t in turns.values) { ids.contains(t.msg) ? (after[t.msg] ??= []).add(t) : tail.add(t); }
    final rows = <Widget>[
      for (final m in msgs) ...[
        _message(context, m, cs),
        for (final t in after[(m['id'] as num?)?.toInt()] ?? const <_Turn>[]) _live(t, cs),
      ],
      for (final t in tail) _live(t, cs),
      for (final m in local.values) _message(context, m, cs),
    ];
    return Scaffold(
      appBar: AppBar(title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis), actions: [
        IconButton(tooltip: '新会话', icon: const Icon(Icons.add_comment_outlined), onPressed: () async {
          final s = await act(context, () => api.call<Map>('sessions.create'));
          if (s != null && context.mounted) Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ChatPage(conv: '${s['id']}', title: '${s['title']}')));
        }),
        IconButton(tooltip: '全部会话', icon: const Icon(Icons.forum_outlined), onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => SessionsPage(current: widget.conv)))),
      ]),
      body: Column(children: [
        Expanded(
          child: Stack(children: [
            loading
                ? const Center(child: CircularProgressIndicator())
                : NotificationListener<ScrollMetricsNotification>(
                    // 贴底：用户在底部时，内容高度变化（Markdown / 图表渲染完成、流式输出、新卡片）都自动跟到最底
                    onNotification: (n) {
                      final grew = n.metrics.maxScrollExtent != lastExtent; // 只在内容高度变化时贴底，用户拖动不受影响
                      lastExtent = n.metrics.maxScrollExtent;
                      if (grew && atBottom && scroll.hasClients && scroll.position.maxScrollExtent - scroll.position.pixels > 1) {
                        WidgetsBinding.instance.addPostFrameCallback((_) { if (scroll.hasClients && atBottom) scroll.jumpTo(scroll.position.maxScrollExtent); });
                      }
                      return false;
                    },
                    child: ListView(controller: scroll, padding: const EdgeInsets.all(12), children: rows.isEmpty ? [const Padding(padding: EdgeInsets.all(48), child: Text('说点什么吧', textAlign: TextAlign.center))] : rows),
                  ),
            if (!atBottom)
              Positioned(
                right: 12, bottom: 12,
                child: unread
                    ? FloatingActionButton.extended(heroTag: null, onPressed: _toBottom, icon: const Icon(Icons.arrow_downward), label: const Text('新消息'))
                    : FloatingActionButton.small(heroTag: null, onPressed: _toBottom, backgroundColor: cs.surfaceContainerHighest, foregroundColor: cs.onSurfaceVariant, child: const Icon(Icons.arrow_downward)),
              ),
          ]),
        ),
        if (files.isNotEmpty) _fileTray(cs),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Row(children: [
              IconButton(tooltip: '附件（最多 $maxFiles 个）', icon: const Icon(Icons.attach_file), onPressed: _pick),
              Expanded(child: TextField(controller: input, minLines: 1, maxLines: 4, decoration: const InputDecoration(hintText: '说点什么', border: OutlineInputBorder()), onSubmitted: (_) => _send())),
              const SizedBox(width: 4),
              IconButton.filled(onPressed: uploading ? null : _send, tooltip: mode == 'steer' ? '发送' : modes[mode]!.$1, icon: Icon(mode == 'steer' ? Icons.send : modes[mode]!.$3)),
              if (turns.isNotEmpty) // 她正在工作：小三角选择发送方式（默认插话；排队 / 打断，再点一次取消）
                PopupMenuButton<String>(
                  tooltip: '她正在工作：这条消息怎么发',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(maxWidth: 260),
                  position: PopupMenuPosition.over,
                  onSelected: (v) => setState(() => mode = mode == v ? 'steer' : v),
                  itemBuilder: (_) => [
                    for (final k in ['queue', 'interrupt'])
                      CheckedPopupMenuItem(value: k, checked: mode == k, child: Text('${modes[k]!.$1}：${modes[k]!.$2}', style: const TextStyle(fontSize: 13))),
                  ],
                  child: const SizedBox(width: 20, height: 40, child: Icon(Icons.arrow_drop_up, size: 22)),
                ),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _fileTray(ColorScheme cs) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(8, 6, 8, 0),
        child: Wrap(spacing: 6, runSpacing: 4, children: [
          for (final f in files)
            InputChip(
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              labelStyle: Theme.of(context).textTheme.labelSmall,
              avatar: f.error != null ? Icon(Icons.error, color: cs.error, size: 18)
                  : f.file == null ? SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, value: f.progress > 0 ? f.progress : null))
                  : Icon(_icon(f.file!), size: 18),
              label: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 140), child: Text(f.error != null ? '${f.name}：${f.error}' : f.name, maxLines: 1, overflow: TextOverflow.ellipsis)),
              onDeleted: () => setState(() => files.remove(f)),
            ),
          Text('${files.length}/$maxFiles', style: Theme.of(context).textTheme.labelSmall),
        ]),
      );

  static IconData _icon(Map f) => switch (f['kind']) { 'image' => Icons.image, 'text' => Icons.description, _ => Icons.insert_drive_file };
  static String _size(num n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${max(1, (n / 1024).round())} KB';

  Widget _message(BuildContext context, Map m, ColorScheme cs) {
    final me = m['role'] == 'user';
    final process = (m['process'] as List?)?.cast<Map>() ?? const [];
    final atts = (m['attachments'] as List?)?.cast<Map>() ?? const [];
    return Column(crossAxisAlignment: me ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
      if (process.isNotEmpty) _Process(process),
      if (atts.isNotEmpty) _attachments(context, atts, me, cs),
      if ('${m['text']}'.isNotEmpty || atts.isEmpty) _bubble(context, '${m['text']}', me, cs, channel: m['channel'], pending: m['pending'] == true),
      if (me && modes[m['mode']] != null) Text('${modes[m['mode']]!.$1} · 在她工作时发送', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: cs.outline)),
    ]);
  }

  Widget _attachments(BuildContext context, List<Map> atts, bool me, ColorScheme cs) {
    final images = atts.where((a) => a['kind'] == 'image' && a['rel'] != null).toList();
    final others = atts.where((a) => !images.contains(a)).toList();
    return Container(
      margin: const EdgeInsets.only(top: 4),
      constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
      child: Column(crossAxisAlignment: me ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
        if (images.isNotEmpty)
          Wrap(spacing: 4, runSpacing: 4, alignment: me ? WrapAlignment.end : WrapAlignment.start, children: [
            for (final a in images)
              GestureDetector(
                onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => Scaffold(appBar: AppBar(title: Text('${a['name']}')),
                    body: InteractiveViewer(maxScale: 6, child: Center(child: Image.network(api.fileUrl('${a['rel']}'))))))),
                child: ClipRRect(borderRadius: BorderRadius.circular(8),
                    child: Image.network(api.fileUrl('${a['rel']}'), width: 96, height: 96, fit: BoxFit.cover,
                        errorBuilder: (_, _, _) => Container(width: 96, height: 96, color: cs.surfaceContainerHighest, child: const Icon(Icons.broken_image)))),
              ),
          ]),
        for (final a in others)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Chip(avatar: Icon(_icon(a), size: 18), label: Text('${a['name']} · ${_size(a['size'] as num? ?? 0)}', maxLines: 1, overflow: TextOverflow.ellipsis)),
          ),
      ]),
    );
  }

  Widget _live(_Turn t, ColorScheme cs) {
    final running = t.items.any((x) => x['type'] == 'tool' && x['status'] == 'running');
    final hint = t.status == 'queued' ? '排队中（这个会话前面还有话没回完）…' : running ? '正在调用工具…' : t.live.isEmpty ? '她在想…' : '';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (t.items.isNotEmpty) _Process(t.items),
      if (t.live.isNotEmpty) _bubble(context, t.live, false, cs, live: true),
      if (hint.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(hint, style: TextStyle(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic))),
    ]);
  }

  Widget _bubble(BuildContext context, String text, bool me, ColorScheme cs, {Object? channel, bool live = false, bool pending = false}) => Opacity(
        opacity: pending ? 0.6 : 1,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: const EdgeInsets.all(10),
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
          decoration: BoxDecoration(color: me ? cs.primaryContainer : cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            me ? SelectableText(text) : RichMarkdown(text, live: live),
            if (channel != null && channel != '控制台') Text('$channel', style: Theme.of(context).textTheme.labelSmall),
          ]),
        ),
      );
}

/// 执行过程：每个工具一行（执行中 / 完成 / 出错 / 被拒绝）；她中途说的话按正常消息气泡完整显示（Markdown）。
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
          if (x['type'] == 'text') // 她中途说的话：正常的消息气泡
            Container(
              margin: const EdgeInsets.symmetric(vertical: 4),
              padding: const EdgeInsets.all(10),
              constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
              decoration: BoxDecoration(color: cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
              child: RichMarkdown('${x['text']}'),
            )
          else
          Container(
            margin: const EdgeInsets.symmetric(vertical: 2),
            padding: const EdgeInsets.only(left: 8),
            decoration: BoxDecoration(border: Border(left: BorderSide(color: cs.outlineVariant, width: 2))),
            child: Row(children: [
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
