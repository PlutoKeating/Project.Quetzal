// 桌面外壳（电脑浏览器、平板横屏）：四栏——导航栏 · 列表栏 · 主区 · 她此刻。
//   导航栏（72）：当前 agent（点击切换）、对话 / 心流 / 记忆 / 控制、急停。
//   列表栏（默认 280，可拖）：这一区的索引——会话、经历、记忆目录、控制菜单；点选后主区显示。
//   主区（至少 420）：对话、一次醒来的完整过程、一篇日记或笔记、一页设置；二级页面在主区内推入 / 返回（嵌套的 Navigator）。
//   她此刻（默认 320，可拖）：光团与状态、她想分享的一句话、正在进行的醒来、待审批、戳一下、内在与身体；永远在那里，不随主区变化。
//   两条分隔线可以拖动，宽度记在本机；窗口不够宽时先压两侧到最小，再收起「她此刻」（导航栏多出一个「此刻」按钮，点开是对话框）。
//   手机上的所有内容组件都原样复用，这里只是把它们放在一起。
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api.dart';
import '../widgets.dart';
import '../platform/tray.dart';
import '../hearing.dart';
import '../host_mode.dart';
import '../platform/location.dart' as loc;
import '../pages/agents.dart';
import '../pages/chat.dart';
import '../pages/control.dart';
import '../pages/flow.dart';
import '../pages/home.dart';
import '../pages/memory.dart';
import '../pages/sessions.dart';
import '../pages/wake.dart';
import 'nav.dart';

const _rail = 72.0;
const _listMin = 200.0, _listMax = 480.0, _presenceMin = 260.0, _presenceMax = 520.0, _mainMin = 420.0;
const _splitter = 9.0; // 分隔线的可抓取宽度（画出来仍是 1 像素）

class DesktopShell extends StatefulWidget {
  const DesktopShell({super.key});
  @override
  State<DesktopShell> createState() => _DesktopShellState();
}

class _DesktopShellState extends State<DesktopShell> {
  final feed = FlowFeed(); // 心流：列表栏与主区共用同一份时间线
  double listW = 280, presenceW = 320; // 用户拖出来的宽度（记在本机）
  bool presenceOpen = true; // 用户有没有主动收起「她此刻」

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (!mounted) return;
      setState(() {
        listW = (p.getDouble('desktop.list') ?? listW).clamp(_listMin, _listMax);
        presenceW = (p.getDouble('desktop.presence') ?? presenceW).clamp(_presenceMin, _presenceMax);
        presenceOpen = p.getBool('desktop.presenceOpen') ?? true;
      });
    });
    nav.addListener(_onNav);
    api.events.listen((e) {
      if (!mounted) return;
      if (e.name == 'say') toast(context, '${api.name}：${'${e.data}'.length > 80 ? '${e.data}'.substring(0, 80) : e.data}');
    });
    api.addListener(_title);
    _title();
  }

  @override
  void dispose() { nav.removeListener(_onNav); api.removeListener(_title); feed.dispose(); super.dispose(); }
  void _onNav() { if (mounted) setState(() {}); _title(); }
  void _title() => loc.setTitle('${api.name} · ${const {'chat': '对话', 'flow': '心流', 'memory': '记忆', 'control': '控制'}[nav.section]}');

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setDouble('desktop.list', listW);
    await p.setDouble('desktop.presence', presenceW);
    await p.setBool('desktop.presenceOpen', presenceOpen);
  }

  /// 「她此刻」收起时从导航栏打开：居中的对话框，内容与右栏完全相同。
  void _presenceDialog() => showSheet(context, (c, _) => const SizedBox(width: 360, child: _PresencePane()), maxWidth: 360);

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final line = VerticalDivider(width: 1, thickness: 1, color: cs.outlineVariant.withValues(alpha: 0.35));
    return ListenableBuilder(
      listenable: api,
      builder: (context, _) => Scaffold(
        body: Column(children: [
          if (api.conn != Conn.online) const OfflineBanner(),
          const HostModeBanner(),
          if (api.safeMode) Banner0(text: '${api.name}反复出错，暂停了醒来', color: Colors.orange),
          ValueListenableBuilder<bool>(valueListenable: consoleStale, builder: (_, stale, _) => !stale ? const SizedBox.shrink()
              : Banner0(text: '新版本已装好', color: Colors.blueGrey, action: FilledButton.tonal(onPressed: relaunchConsole, child: const Text('重新打开')))),
          Expanded(
            child: LayoutBuilder(builder: (context, box) {
              // 分配宽度：主区至少 _mainMin。不够时先把「她此刻」压到最小，再压列表栏，仍不够就收起「她此刻」
              final total = box.maxWidth - _rail - 1 - _splitter;
              var list = listW.clamp(_listMin, _listMax), pres = presenceW.clamp(_presenceMin, _presenceMax);
              var fits = presenceOpen && total - _splitter - list - pres >= _mainMin;
              if (presenceOpen && !fits) {
                pres = max(_presenceMin, total - _splitter - list - _mainMin);
                if (total - _splitter - list - pres < _mainMin) list = max(_listMin, total - _splitter - pres - _mainMin);
                fits = total - _splitter - list - pres >= _mainMin;
              }
              if (!fits) { pres = 0; if (total - list < _mainMin) list = max(_listMin, total - _mainMin); }
              final roomForPresence = total - _splitter - _listMin - _presenceMin >= _mainMin;
              return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                SizedBox(width: _rail, child: _Rail(presenceShown: fits, onPresence: () {
                  if (roomForPresence) { setState(() => presenceOpen = !presenceOpen); _save(); } else { _presenceDialog(); }
                })),
                line,
                SizedBox(width: list, child: _ListPane(feed: feed)),
                _Splitter(onDrag: (dx) => setState(() => listW = (list + dx).clamp(_listMin, _listMax)), onEnd: _save),
                Expanded(child: _MainArea(feed: feed)),
                if (fits) ...[
                  _Splitter(onDrag: (dx) => setState(() => presenceW = (pres - dx).clamp(_presenceMin, _presenceMax)), onEnd: _save),
                  SizedBox(width: pres, child: const _PresencePane()),
                ],
              ]);
            }),
          ),
        ]),
      ),
    );
  }
}

/// 可拖动的分隔线：画 1 像素，抓取区 9 像素，悬停与拖动时变成主题色。
class _Splitter extends StatefulWidget {
  final void Function(double dx) onDrag;
  final VoidCallback onEnd;
  const _Splitter({required this.onDrag, required this.onEnd});
  @override
  State<_Splitter> createState() => _SplitterState();
}

class _SplitterState extends State<_Splitter> {
  bool hover = false, dragging = false;
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final on = hover || dragging;
    return MouseRegion(
      cursor: SystemMouseCursors.resizeLeftRight,
      onEnter: (_) => setState(() => hover = true),
      onExit: (_) => setState(() => hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onHorizontalDragStart: (_) => setState(() => dragging = true),
        onHorizontalDragUpdate: (d) => widget.onDrag(d.delta.dx),
        onHorizontalDragEnd: (_) { setState(() => dragging = false); widget.onEnd(); },
        onHorizontalDragCancel: () => setState(() => dragging = false),
        child: SizedBox(
          width: _splitter,
          child: Center(child: AnimatedContainer(duration: const Duration(milliseconds: 120), width: on ? 2 : 1, color: on ? cs.primary.withValues(alpha: 0.8) : cs.outlineVariant.withValues(alpha: 0.35))),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- 导航栏
class _Rail extends StatelessWidget {
  final bool presenceShown;
  final VoidCallback onPresence;
  const _Rail({required this.presenceShown, required this.onPresence});
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return ListenableBuilder(listenable: Listenable.merge([nav, api]), builder: (context, _) => Column(children: [
      const SizedBox(height: 14),
      Tooltip(
        message: '切换',
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: () => showAgentSheet(context),
          child: Padding(padding: const EdgeInsets.all(6), child: CircleAvatar(radius: 14, backgroundColor: api.color, child: Text(api.name.isEmpty ? '?' : api.name.substring(0, 1), style: TextStyle(color: const Color(0xFF1A120A), fontWeight: FontWeight.bold, fontSize: 14)))),
        ),
      ),
      const SizedBox(height: 18),
      _dest(context, 'chat', Icons.chat_bubble_outline, Icons.chat_bubble, '对话'),
      _dest(context, 'flow', Icons.timeline_outlined, Icons.timeline, '心流'),
      _dest(context, 'memory', Icons.auto_stories_outlined, Icons.auto_stories, '记忆'),
      _dest(context, 'control', Icons.tune_outlined, Icons.tune, '控制', badge: api.approvals.length),
      const Spacer(),
      // 「她此刻」：窗口够宽时是右栏的开关，不够宽（右栏自动收起）时点开对话框
      IconButton(tooltip: presenceShown ? '收起「她此刻」' : '她此刻', icon: Icon(presenceShown ? Icons.brightness_3 : Icons.brightness_3_outlined, size: 20, color: presenceShown ? cs.primary : cs.onSurfaceVariant), onPressed: onPresence),
      const SizedBox(height: 6),
      const StopButton(),
      const SizedBox(height: 6),
      Text(switch (api.conn) { Conn.online => '在线', Conn.connecting => '连接中', Conn.igniting => '点火中', Conn.offline => '离线', Conn.unpaired => '未配对' },
          style: Theme.of(context).textTheme.labelSmall?.copyWith(color: api.conn == Conn.online ? cs.outline : cs.error)),
      const SizedBox(height: 14),
    ]));
  }

  Widget _dest(BuildContext context, String id, IconData icon, IconData active, String label, {int badge = 0}) {
    final cs = Theme.of(context).colorScheme, on = nav.section == id;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => nav.go(id),
        child: Container(
          width: 60, padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(color: on ? cs.surfaceContainerHigh : null, borderRadius: BorderRadius.circular(12)),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Badge(isLabelVisible: badge > 0, label: Text('$badge'), child: Icon(on ? active : icon, size: 22, color: on ? cs.primary : cs.onSurfaceVariant)),
            const SizedBox(height: 4),
            Text(label, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: on ? cs.onSurface : cs.onSurfaceVariant)),
          ]),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- 列表栏
class _ListPane extends StatelessWidget {
  final FlowFeed feed;
  const _ListPane({required this.feed});
  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: nav, builder: (context, _) => switch (nav.section) {
        'chat' => SessionsList(key: const ValueKey('sessions'), current: nav.id, onOpen: (s) => nav.go('chat', id: '${s['id']}')),
        'flow' => FlowList(feed: feed, selected: nav.id, onSelect: (id) => nav.go('flow', id: id.isEmpty ? null : id)),
        'memory' => const _MemoryIndex(),
        _ => ControlPage(selected: nav.id ?? 'identity', onSelect: (it) => nav.go('control', id: it.id)),
      });
}

/// 记忆的索引：核心 / 日记（按天）/ 笔记（目录树）/ 搜索。
class _MemoryIndex extends StatelessWidget {
  const _MemoryIndex();
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final sub = nav.sub ?? 'core';
    Widget tab(String id, IconData icon, String label) => ListTile(
          dense: true, selected: sub == id, leading: Icon(icon, size: 20), title: Text(label),
          onTap: () => nav.go('memory', sub: id));
    return Column(children: [
      const SizedBox(height: 6),
      tab('core', Icons.favorite_outline, '核心'),
      tab('journal', Icons.menu_book_outlined, '日记'),
      tab('notes', Icons.sticky_note_2_outlined, '笔记'),
      tab('search', Icons.search, '搜索'),
      Divider(height: 9, color: cs.outlineVariant.withValues(alpha: 0.35)),
      Expanded(child: switch (sub) {
        'journal' => JournalList(selected: nav.id, onOpen: (d) => nav.go('memory', sub: 'journal', id: '${d['body']}/${d['day']}')),
        'notes' => NotesList(selected: nav.id, onOpen: (n) => nav.go('memory', sub: 'notes', id: '${n['name']}')),
        _ => const SizedBox.shrink(),
      }),
    ]);
  }
}

// ---------------------------------------------------------------- 主区
class _MainArea extends StatefulWidget {
  final FlowFeed feed;
  const _MainArea({required this.feed});
  @override
  State<_MainArea> createState() => _MainAreaState();
}

class _MainAreaState extends State<_MainArea> {
  bool resolving = false, everOnline = false;

  @override
  void initState() { super.initState(); nav.addListener(_resolve); widget.feed.addListener(_resolve); api.addListener(_resolve); _resolve(); }
  @override
  void dispose() { nav.removeListener(_resolve); widget.feed.removeListener(_resolve); api.removeListener(_resolve); super.dispose(); }

  /// 没有选中具体一条时的缺省：对话 → 最近的会话（没有就新建）；心流 → 最新的经历；控制 → 身份。
  Future<void> _resolve() async {
    if (nav.section == 'chat' && nav.id == null && !resolving && api.conn == Conn.online) {
      resolving = true;
      try {
        final list = await api.call<List>('sessions');
        final s = list.isNotEmpty ? list.first as Map : await api.call<Map>('sessions.create');
        if (nav.section == 'chat' && nav.id == null) nav.go('chat', id: '${s['id']}');
      } catch (_) {}
      resolving = false;
    }
    if (nav.section == 'flow' && nav.id == null && widget.feed.items.isNotEmpty) nav.go('flow', id: '${widget.feed.items.first['id']}');
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Listenable.merge([nav, api]),
        builder: (context, _) {
          if (api.conn == Conn.unpaired) return const SizedBox.shrink();
          // 第一次连上之前不建页面（页面在 initState 里就会向她要数据）；之后断线也不拆，重连后页面自己补
          everOnline = everOnline || api.conn == Conn.online;
          if (!everOnline) return _hint('正在连接…');
          final key = ValueKey('${nav.section}/${nav.sub}/${nav.id}');
          Widget content = switch (nav.section) {
            'chat' => _chat(),
            'flow' => _flow(),
            'memory' => _memory(),
            _ => _control(),
          };
          // 嵌套的 Navigator：二级页面（审计详情、工具详情、记忆历史的一次提交）在主区内推入与返回
          return Navigator(key: key, onGenerateRoute: (_) => MaterialPageRoute(builder: (_) => content));
        },
      );

  Widget _hint(String text) => Center(child: Text(text, style: TextStyle(color: Theme.of(context).colorScheme.outline)));

  Widget _chat() {
    final conv = nav.id;
    if (conv == null) return _hint(api.conn == Conn.online ? '正在打开会话…' : '连上她之后，这里是你们的对话');
    return _ChatPane(conv: conv);
  }

  Widget _flow() {
    final id = nav.id;
    if (id == null) return _hint(widget.feed.loading ? '' : '还没有经历');
    if (id == 'dist') return PageFrame(title: '醒来分布', body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: FlowDistribution(widget.feed.items))));
    if (id.startsWith('live:')) return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: WakeView(key: ValueKey(id), turn: id.substring(5), framed: true)));
    final e = widget.feed.byId(id);
    if (e == null) return _hint('这条经历不在已加载的范围里');
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: WakeView(key: ValueKey(id), entry: e, framed: true)));
  }

  Widget _memory() {
    final sub = nav.sub ?? 'core', id = nav.id;
    Widget doc(String title, Future<String> Function() load) => PageFrame(title: title, body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: MarkdownDoc(key: ValueKey('$sub/$id'), load: load))));
    return switch (sub) {
      'journal' => id == null ? _hint('左边选一天') : doc(id.replaceFirst('/', ' · '), () => api.call<String>('journal', {'body': id.split('/').first, 'day': id.split('/').skip(1).join('/')})),
      'notes' => id == null ? _hint('左边选一篇笔记') : doc(id, () => api.call<String>('note', {'name': id})),
      'search' => PageFrame(title: '搜索记忆', body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: const MemorySearch()))),
      _ => PageFrame(title: '核心：人格与常驻记忆', body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: const MemoryCore()))),
    };
  }

  Widget _control() {
    final item = controlItem(nav.id);
    return Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: item.page()));
  }
}

/// 主区里的一个会话：标题随后端更新；她切会话时跟过去。
class _ChatPane extends StatefulWidget {
  final String conv;
  const _ChatPane({required this.conv});
  @override
  State<_ChatPane> createState() => _ChatPaneState();
}

class _ChatPaneState extends State<_ChatPane> {
  String title = '对话';
  @override
  Widget build(BuildContext context) => PageFrame(
        title: title,
        actions: [
          IconButton(tooltip: '新会话', icon: const Icon(Icons.add_comment_outlined, size: 20), onPressed: () async {
            final s = await act(context, () => api.call<Map>('sessions.create'));
            if (s != null) nav.go('chat', id: '${s['id']}');
          }),
          HostModeButton(conv: widget.conv, size: 20),
        ],
        body: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 820), child: ChatView(
          conv: widget.conv,
          onTitle: (t) { if (t != title && mounted) setState(() => title = t); },
          onSwitch: (to, t) => nav.go('chat', id: to),
        ))),
      );
}

// ---------------------------------------------------------------- 她此刻
class _PresencePane extends StatelessWidget {
  const _PresencePane();
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme, t = Theme.of(context).textTheme;
    Widget label(String s) => Padding(padding: const EdgeInsets.fromLTRB(20, 18, 20, 6), child: Text(s, style: t.labelLarge?.copyWith(color: cs.onSurfaceVariant)));
    return ListenableBuilder(
      listenable: Listenable.merge([api, wakes, hearing]),
      builder: (context, _) {
        final inhibitors = (api.heart['inhibitors'] as List?)?.cast<String>() ?? [];
        return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
          const SizedBox(height: 28),
          const PresenceHead(size: 132),
          const ThoughtLine(),
          const ModelNudge(),
          if (inhibitors.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(20, 6, 20, 0), child: Text(inhibitors.join('、'), textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: Colors.orange))),
          const SizedBox(height: 14),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: FilledButton.tonalIcon(icon: const Icon(Icons.touch_app, size: 18), label: const Text('戳一下'), onPressed: () => poke(context))),
          if (wakes.list.isNotEmpty) ...[
            label('正在发生'),
            for (final w in wakes.list) Padding(padding: const EdgeInsets.symmetric(horizontal: 8), child: LiveWakeTile(w, selected: nav.section == 'flow' && nav.id == 'live:${w.id}', onTap: () => nav.go('flow', id: 'live:${w.id}'))),
          ],
          if (api.approvals.isNotEmpty) ...[
            label('待你决定'),
            for (final a in api.approvals) Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: ApprovalCard(a as Map, compact: true)),
          ],
          if (((api.status['reminders'] as List?) ?? []).isNotEmpty) ...[
            label('提醒'),
            const Padding(padding: EdgeInsets.symmetric(horizontal: 20), child: RemindersSection(compact: true)),
          ],
          label('内在'),
          const Padding(padding: EdgeInsets.symmetric(horizontal: 20), child: InnerSection(compact: true)),
          label('身体'),
          const Padding(padding: EdgeInsets.symmetric(horizontal: 20), child: BodySection(compact: true)),
        ]);
      },
    );
  }
}
