// 对话：一个会话的完整界面。多个会话可以同时进行（见 sessions.dart），后端让每个会话都能看到其他会话。
//   后端是唯一的事实来源：打开页面、断线重连、从后台切回、每一轮结束时，都从后端取回对话记录与「进行中的轮次」快照重建界面，
//   期间的实时进展（流式文字、工具卡片）由 activity 推送增量更新。所以切到后台再回来，进行中的卡片会完整恢复并继续更新。
//   附件：一次最多 20 个文件，先上传到基座，再随消息发送（图片直接进消息，文本内联，文档给路径由她自己读）。
//   她工作时发消息：默认「插话」（这次模型调用结束后并入）；发送按钮右侧的小三角可改为「排队」（下一轮）或「打断」（立即中止当前模型输出，不打断工具）。
//   保密输入（她调用 pass_secret 时）：输入框上方出现提示，此后每条消息都是一项保密值——不显示在对话里，输入框默认遮挡；
//   「完成 / 重填 / 取消」按钮与发回结束口令等价。状态来自 secret 推送，重建界面时从 secrets.pending 取回。
//   滚动：打开即在最底部；在底部时新内容自动跟随；上滑后右下角出现「回到底部」，有新内容时变亮并显示「新消息」。
//   气泡、工具卡片与进行中的一轮（LiveTurn）在 process.dart 里，与只读的「醒来记录」页共用。
//   ChatView 是对话的全部内容（记录、过程、输入）；ChatPage 在手机上给它套 AppBar，桌面外壳把它放进主区。
//   桌面：Enter 发送、Shift+Enter 换行；内容宽度由外壳限制（PaneWidth）。
import 'dart:async';
import 'dart:math';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../api.dart';
import '../widgets.dart';
import '../shell/nav.dart';
import '../markdown.dart';
import '../process.dart';
import '../hearing.dart';
import 'sessions.dart';

const maxFiles = 20;
const modes = {'steer': ('插话', '这一步结束后并入，她会注意到', Icons.call_merge), 'queue': ('排队', '等这一轮结束后再处理', Icons.schedule_send), 'interrupt': ('打断', '立即打断她的输出，工具不受影响', Icons.pan_tool)};

/// 待发送的附件（上传中 / 已上传 / 失败）。
class _Pending {
  final String name;
  final int size;
  double progress = 0;
  Map? file;
  String? error;
  _Pending(this.name, this.size);
}

/// 手机：一个会话一页。
class ChatPage extends StatefulWidget {
  final String conv, title;
  const ChatPage({super.key, required this.conv, this.title = '对话'});
  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  late String title = widget.title;
  @override
  void initState() { super.initState(); nav.go('chat', id: widget.conv); } // 记下位置：窗口变宽切到桌面外壳时接着这个会话
  @override
  Widget build(BuildContext context) => PageFrame(
        title: title,
        actions: [
          IconButton(tooltip: '新会话', icon: const Icon(Icons.add_comment_outlined), onPressed: () async {
            final s = await act(context, () => api.call<Map>('sessions.create'));
            if (s != null && context.mounted) Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ChatPage(conv: '${s['id']}', title: '${s['title']}')));
          }),
          IconButton(tooltip: '全部会话', icon: const Icon(Icons.forum_outlined), onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => SessionsPage(current: widget.conv)))),
        ],
        body: ChatView(
          conv: widget.conv,
          onTitle: (t) => setState(() => title = t),
          onSwitch: (to, t) => Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => ChatPage(conv: to, title: t))),
        ),
      );
}

/// 一个会话的全部内容：记录、进行中的过程、附件、输入框。onTitle：标题随后端更新；onSwitch：她用 session_new 切到了新会话。
class ChatView extends StatefulWidget {
  final String conv;
  final void Function(String title)? onTitle;
  final void Function(String conv, String title)? onSwitch;
  const ChatView({super.key, required this.conv, this.onTitle, this.onSwitch});
  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final msgs = <Map>[];
  final turns = <String, LiveTurn>{};
  final local = <String, Map>{}; // 刚发出、后端还没确认的话（turn → 消息）
  final finished = <String>{}; // 已结束的轮次：取回快照时忽略（防止与已入库的回复重复）
  final files = <_Pending>[];
  final input = TextEditingController();
  final scroll = ScrollController();
  final subs = <StreamSubscription>[];
  late final AppLifecycleListener life;
  final focus = FocusNode();
  bool atBottom = true, unread = false, wasOnline = true, loading = true;
  String mode = 'steer'; // 她正在工作时发消息的方式
  Map? secret; // 这个会话进行中的保密输入（pass_secret）
  Map? heard; // 耳朵正在听的一句话：{id, text, status}。partial 流式显示；final 后等记录里出现这条消息；她判断不是对她说的（ignored）就消失
  bool reveal = false; // 保密输入时显示明文（多行的值如私钥需要打开）
  double lastExtent = 0;

  @override
  void initState() {
    super.initState();
    scroll.addListener(_onScroll);
    subs.add(api.events.where((e) => e.name == 'activity').listen(_onActivity));
    subs.add(api.events.where((e) => e.name == 'say').listen((_) { if (widget.conv == 'inbox') _resync(); }));
    subs.add(api.events.where((e) => e.name == 'secret').listen(_onSecret));
    subs.add(api.events.where((e) => e.name == 'hearing').listen(_onHearing));
    subs.add(api.events.where((e) => e.name == 'session.switch').listen((e) { // 她用 session_new 切到了新会话：跟着切过去
      final s = e.data as Map;
      if (s['from'] != widget.conv || s['done'] == true || !mounted) return;
      widget.onSwitch?.call('${s['to']}', '${s['title']}');
    }));
    subs.add(api.events.where((e) => e.name == 'session.switch' && (e.data as Map)['to'] == widget.conv && (e.data as Map)['done'] == true).listen((_) => _resync())); // 回复落进了这个新会话
    api.addListener(_onConn);
    life = AppLifecycleListener(onResume: () async { await api.ensureAlive(); _resync(); }); // 从后台切回：确认连接并从后端重建
    _resync(first: true);
  }

  @override
  void didUpdateWidget(ChatView old) {
    super.didUpdateWidget(old);
    if (old.conv != widget.conv) { // 桌面外壳复用同一个 ChatView 切换会话
      msgs.clear(); turns.clear(); local.clear(); finished.clear(); files.clear();
      secret = null; heard = null; loading = true; atBottom = true; unread = false;
      setState(() {});
      _resync(first: true);
    }
  }

  @override
  void dispose() {
    for (final s in subs) { s.cancel(); }
    api.removeListener(_onConn);
    life.dispose();
    focus.dispose();
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
      final r = await Future.wait([api.call<List>('sessions.messages', {'id': widget.conv, 'limit': 100}), api.call<List>('sessions.live'), api.call<List>('sessions'),
        api.call<List>('secrets.pending').catchError((_) => []), // 旧版基座没有这个接口
      ]);
      if (!mounted) return;
      final me = r[2].cast<Map>().where((s) => s['id'] == widget.conv);
      final pending = r[3].cast<Map>().where((s) => s['conv'] == widget.conv);
      setState(() {
        secret = pending.isEmpty ? null : pending.first;
        msgs..clear()..addAll(r[0].cast<Map>());
        if (heard != null && heard!['status'] != 'partial' && msgs.any((m) => m['role'] == 'ambient' && m['text'] == heard!['text'])) heard = null; // 记录里已经有这句话了
        turns
          ..clear()
          ..addEntries(r[1].cast<Map>().where((t) => t['conv'] == widget.conv && t['origin'] == 'chat' && !finished.contains(t['turn'])).map((t) => MapEntry('${t['turn']}', LiveTurn.snapshot(t))));
        local.removeWhere((k, _) => turns.containsKey(k) || msgs.any((m) => m['role'] == 'user' && m['text'] == local[k]!['text']));
        loading = false;
      });
      if (me.isNotEmpty) widget.onTitle?.call('${me.first['title']}');
      _changed(force: first);
    } catch (_) {
      if (mounted) setState(() => loading = false);
    }
  }

  /// 听觉：中间结果流式显示在最底部；识别完成进入别的会话就不显示；她判断不是对她说的（ignored）或没进会话（dropped）就消失，回应了（kept）则由记录里的那条消息接替。
  void _onHearing(GatewayEvent e) {
    final h = e.data as Map;
    if (!mounted) return;
    switch (h['status']) {
      case 'partial': setState(() => heard = {'id': h['id'], 'text': h['text'], 'status': 'partial'});
      case 'final': setState(() => heard = h['conv'] == widget.conv ? {'id': h['id'], 'text': h['text'], 'status': 'final'} : null);
      case 'dropped': setState(() => heard = null);
      case 'ignored': setState(() => heard = null); _resync(); // 这句话已标为 ignored：重取记录即隐藏
      case 'kept': if (heard?['id'] == h['id']) _resync();
    }
    _changed();
  }

  void _onSecret(GatewayEvent e) {
    final s = e.data as Map;
    if (s['conv'] != widget.conv || !mounted) return;
    final live = s['status'] == 'open' || s['status'] == 'progress';
    setState(() { secret = live ? s : null; if (!live) reveal = false; });
    if (s['status'] == 'expired') toast(context, '保密输入太久没有动静，已自动取消');
  }

  /// 保密输入期间发送：这条消息是一项保密值，不显示在对话里，只提示回执。
  Future<void> _sendSecret(String text) async {
    if (text.trim().isEmpty) return;
    input.clear();
    final ack = await act(context, () => api.call<String>('chat.send', {'conv': widget.conv, 'text': text}));
    if (ack != null && mounted) toast(context, ack.replaceAll('`', ''));
  }

  void _onActivity(GatewayEvent e) {
    final a = e.data as Map;
    if (a['conv'] != widget.conv || a['origin'] != 'chat' || !mounted) return;
    final id = '${a['session']}';
    switch (a['kind']) {
      case 'start':
        local.remove(id);
        turns[id] = LiveTurn(id, (a['msg'] as num?)?.toInt() ?? 0, '${a['text'] ?? ''}', conv: widget.conv);
        _resync(); // 取回这句话（也可能来自另一个客户端）
        return;
      case 'steer':
        turns[id]?.apply(a); // 先打上插话标记（之前的过程截断在这句话上方），再取回这句话
        _resync();
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
    setState(() => t.apply(a));
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
        p.file = await api.upload(f.name, await f.readAsBytes(), onProgress: (v) { if (mounted) setState(() => p.progress = v); });
      } catch (e) {
        p.error = '$e';
      }
      if (mounted) setState(() {});
    }
  }

  bool get uploading => files.any((f) => f.file == null && f.error == null);

  Future<void> _send() async {
    if (secret != null) return _sendSecret(input.text);
    final text = input.text.trim();
    focus.requestFocus();
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
    // 过程按插话标记分段：插话到达之前的过程留在插话消息上方，之后的从插话消息下面重新开出。
    // 进行中的轮次：第一段挂在这一轮开始的那句话下面，之后每段挂在对应的插话消息下面；找不到对应消息时放在最后。
    // 已入库的回复：过程里插话之前的各段同样提到对应插话消息的上方，回复本身只带最后一段。
    final before = <int, List<Widget>>{}, after = <int, List<Widget>>{};
    final tail = <Widget>[];
    final ids = msgs.map((m) => (m['id'] as num?)?.toInt()).toSet();
    final lastSeg = <int, List<Map>>{}; // 已入库的回复：只渲染最后一段
    for (final m in msgs) {
      if (m['role'] != 'agent') continue;
      final segs = splitAtSteer((m['process'] as List?)?.cast<Map>() ?? const []);
      if (segs.length == 1) continue;
      for (var k = 0; k < segs.length - 1; k++) {
        final anchor = segs[k + 1].msg;
        if (segs[k].items.isEmpty) continue;
        (anchor != null && ids.contains(anchor) ? (before[anchor] ??= []) : tail).add(ProcessView(segs[k].items));
      }
      lastSeg[(m['id'] as num).toInt()] = segs.last.items;
    }
    for (final t in turns.values) {
      final segs = splitAtSteer(t.items);
      for (var k = 0; k < segs.length - 1; k++) {
        final anchor = segs[k + 1].msg;
        if (segs[k].items.isEmpty) continue;
        (anchor != null && ids.contains(anchor) ? (before[anchor] ??= []) : tail).add(ProcessView(segs[k].items));
      }
      final anchor = segs.length > 1 ? segs.last.msg : t.msg;
      (anchor != null && ids.contains(anchor) ? (after[anchor] ??= []) : tail).add(_live(t, segs.last.items, cs));
    }
    final rows = <Widget>[
      for (final m in msgs) ...[
        ...before[(m['id'] as num?)?.toInt()] ?? const <Widget>[],
        _message(context, m, cs, process: lastSeg[(m['id'] as num?)?.toInt()]),
        ...after[(m['id'] as num?)?.toInt()] ?? const <Widget>[],
      ],
      ...tail,
      for (final m in local.values) _message(context, m, cs),
      if (heard != null) _heardLive(context, heard!, cs),
    ];
    final desktop = ShellScope.isDesktop(context);
    return LayoutBuilder(builder: (context, box) => PaneWidth(width: box.maxWidth, child: Column(children: [
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
                    child: ListView(controller: scroll, padding: EdgeInsets.symmetric(horizontal: desktop ? 24 : 12, vertical: 12), children: rows.isEmpty ? [const Padding(padding: EdgeInsets.all(48), child: Text('说点什么吧', textAlign: TextAlign.center))] : rows),
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
        if (secret != null) _secretBar(secret!, cs),
        ListenableBuilder(listenable: hearing, builder: (context, _) => hearing.caption == null ? const SizedBox.shrink() : _listening(cs)), // 耳朵开着：让对方知道她在听
        SafeArea(
          child: Padding(
            padding: EdgeInsets.fromLTRB(desktop ? 20 : 8, 8, desktop ? 20 : 8, desktop ? 16 : 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
              if (secret == null) IconButton(tooltip: '附件（最多 $maxFiles 个）', icon: const Icon(Icons.attach_file), onPressed: _pick),
              Expanded(
                child: secret == null
                    ? (desktop
                        // 桌面：Enter 发送，Shift+Enter 换行
                        ? KeyboardListener(
                            focusNode: FocusNode(skipTraversal: true),
                            onKeyEvent: (e) {
                              if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.enter && !HardwareKeyboard.instance.isShiftPressed) { _send(); }
                            },
                            child: TextField(controller: input, focusNode: focus, minLines: 1, maxLines: 8, textInputAction: TextInputAction.newline,
                                decoration: const InputDecoration(hintText: '说点什么（Enter 发送，Shift+Enter 换行）', border: OutlineInputBorder()),
                                onChanged: (v) { if (v.endsWith('\n') && !HardwareKeyboard.instance.isShiftPressed) input.text = v.substring(0, v.length - 1); }))
                        : TextField(controller: input, focusNode: focus, minLines: 1, maxLines: 4, decoration: const InputDecoration(hintText: '说点什么', border: OutlineInputBorder()), onSubmitted: (_) => _send()))
                    // 保密输入：默认遮挡（单行）；多行的值先点眼睛显示再粘贴
                    : TextField(controller: input, obscureText: !reveal, minLines: 1, maxLines: reveal ? 6 : 1, autocorrect: false, enableSuggestions: false, onSubmitted: reveal ? null : (_) => _send(),
                        decoration: InputDecoration(hintText: _secretHint(secret!), border: const OutlineInputBorder(), prefixIcon: const Icon(Icons.lock_outline),
                            suffixIcon: IconButton(tooltip: reveal ? '遮挡' : '显示（多行内容需要显示后再粘贴）', icon: Icon(reveal ? Icons.visibility_off : Icons.visibility), onPressed: () => setState(() => reveal = !reveal)))),
              ),
              const SizedBox(width: 4),
              IconButton.filled(onPressed: uploading ? null : _send, tooltip: secret != null ? '保密发送' : mode == 'steer' ? '发送' : modes[mode]!.$1, icon: Icon(secret != null ? Icons.enhanced_encryption : mode == 'steer' ? Icons.send : modes[mode]!.$3)),
              if (turns.isNotEmpty && secret == null) // 她正在工作：小三角选择发送方式（默认插话；排队 / 打断，再点一次取消）
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
      ])));
  }

  static String _secretHint(Map s) {
    final items = (s['items'] as List).cast<Map>(), got = (s['got'] as num).toInt();
    return got < items.length ? '第 ${got + 1} 项：${items[got]['name']}' : '已收齐，点「完成」';
  }

  /// 保密输入的提示条：要哪几项、收到了几项；完成 / 重填 / 取消（与发回结束口令等价）。
  Widget _secretBar(Map s, ColorScheme cs) {
    final items = (s['items'] as List).cast<Map>(), got = (s['got'] as num).toInt(), t = Theme.of(context).textTheme;
    return Material(
      color: cs.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Icon(Icons.lock, size: 18, color: cs.onTertiaryContainer), const SizedBox(width: 6), Expanded(child: Text('保密输入${'${s['purpose']}'.isEmpty ? '' : ' · ${s['purpose']}'}', style: t.titleSmall?.copyWith(color: cs.onTertiaryContainer)))]),
          Text('现在发的每一条消息都是一项的值：不进入对话，直接存进保密库，${api.name} 看不到明文。', style: t.bodySmall?.copyWith(color: cs.onTertiaryContainer)),
          const SizedBox(height: 4),
          for (final (i, it) in items.indexed)
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(i < got ? Icons.check_circle : i == got ? Icons.radio_button_checked : Icons.radio_button_unchecked, size: 16, color: cs.onTertiaryContainer),
              const SizedBox(width: 6),
              Expanded(child: Text('${it['name']}${'${it['hint']}'.isEmpty ? '' : ' — ${it['hint']}'}', style: t.bodySmall?.copyWith(color: cs.onTertiaryContainer, fontWeight: i == got ? FontWeight.bold : null))),
            ]),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            TextButton(onPressed: () => act(context, () => api.call('secrets.end', {'id': s['id'], 'cancel': true}), ok: '已取消，没有保存任何内容'), child: const Text('取消')),
            if (got > 0) TextButton(onPressed: () => _sendSecret('${s['spell']} 重来'), child: const Text('重填')),
            FilledButton(onPressed: got == 0 ? null : () => act(context, () => api.call('secrets.end', {'id': s['id']}), ok: '已存入保密库'), child: Text(got < items.length ? '完成（$got/${items.length}）' : '完成')),
          ]),
        ]),
      ),
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

  /// 聆听状态的一行：在听（灰）→ 有人在说话 / 正在听清（主题色）。
  Widget _listening(ColorScheme cs) {
    final lit = hearing.lit, color = lit ? cs.primary : cs.outline;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 0),
      child: Row(children: [
        AnimatedContainer(duration: const Duration(milliseconds: 300), width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: color.withValues(alpha: lit ? 1 : 0.5))),
        const SizedBox(width: 6),
        Icon(Icons.hearing, size: 13, color: color),
        const SizedBox(width: 4),
        Text(hearing.caption ?? '', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color)),
        if (hearing.pending && !hearing.speaking) ...[const SizedBox(width: 6), SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.5, color: color))],
      ]),
    );
  }

  Widget _message(BuildContext context, Map m, ColorScheme cs, {List<Map>? process}) {
    if (m['role'] == 'ambient') return _ambient(context, m, cs);
    final me = m['role'] == 'user';
    process ??= (m['process'] as List?)?.cast<Map>() ?? const [];
    final atts = (m['attachments'] as List?)?.cast<Map>() ?? const [];
    return Column(crossAxisAlignment: me ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
      if (process.isNotEmpty) ProcessView(process),
      if (atts.isNotEmpty) _attachments(context, atts, me, cs),
      if ('${m['text']}'.isNotEmpty || atts.isEmpty) Bubble('${m['text']}', me: me, channel: m['channel'], pending: m['pending'] == true),
      if (me && modes[m['mode']] != null) Text('${modes[m['mode']]!.$1} · 在她工作时发送', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: cs.outline)),
    ]);
  }

  /// 耳朵正在听的一句话：和环境声音同样的样式，末尾一个小点表示还在听清。
  Widget _heardLive(BuildContext context, Map h, ColorScheme cs) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 24),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.hearing, size: 14, color: cs.primary),
          const SizedBox(width: 6),
          Flexible(child: Text('${h['text']}${h['status'] == 'partial' ? ' …' : ''}', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic))),
          if (h['status'] != 'partial') ...[const SizedBox(width: 6), SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.5, color: cs.outline))],
        ]),
      );

  /// 环境输入：不是对方发的消息，也不是她的话——居中、安静地显示，她的回应（如果有）紧随其后。
  /// 通道决定图标：语音（麦克风听到的）、子agent（送回的报告）、摘要（session_compact）、交接（session_new）。她判断不是对她说的环境声音（mode 为 ignored）不显示。
  Widget _ambient(BuildContext context, Map m, ColorScheme cs) {
    if (m['mode'] == 'ignored') return const SizedBox.shrink();
    final ch = '${m['channel']}';
    final icon = switch (ch) { '子agent' => Icons.smart_toy_outlined, '摘要' => Icons.compress, '交接' => Icons.swap_horiz, _ => Icons.hearing };
    final long = ch == '子agent' || ch == '摘要' || ch == '交接';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 24),
      child: Row(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 14, color: cs.outline),
        const SizedBox(width: 6),
        Flexible(child: long
            ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(ch == '子agent' ? '子 agent 的报告' : ch == '摘要' ? '上下文已压缩，摘要' : '交接', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: cs.outline)),
                RichMarkdown('${m['text']}'),
              ])
            : Text('${m['text']}', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic))),
      ]),
    );
  }

  Widget _attachments(BuildContext context, List<Map> atts, bool me, ColorScheme cs) {
    final images = atts.where((a) => a['kind'] == 'image' && a['rel'] != null).toList();
    final others = atts.where((a) => !images.contains(a)).toList();
    return Container(
      margin: const EdgeInsets.only(top: 4),
      constraints: BoxConstraints(maxWidth: PaneWidth.of(context) * 0.8),
      child: Column(crossAxisAlignment: me ? CrossAxisAlignment.end : CrossAxisAlignment.start, children: [
        if (images.isNotEmpty)
          Wrap(spacing: 4, runSpacing: 4, alignment: me ? WrapAlignment.end : WrapAlignment.start, children: [
            for (final a in images)
              GestureDetector(
                onTap: () => showDialog(context: context, builder: (x) => Dialog.fullscreen(child: Column(children: [
                    AppBar(title: Text('${a['name']}'), leading: IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(x))),
                    Expanded(child: InteractiveViewer(maxScale: 6, child: Center(child: Image.network(api.fileUrl('${a['rel']}'))))),
                  ]))),
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

  Widget _live(LiveTurn t, List<Map> items, ColorScheme cs) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (items.isNotEmpty) ProcessView(items),
        if (t.live.isNotEmpty) Bubble(t.live, live: true),
        if (t.hint.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(t.hint, style: TextStyle(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic))),
      ]);
}
