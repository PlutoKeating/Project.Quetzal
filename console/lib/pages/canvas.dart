// Canvas 面板（#33 运行代码、#34 评论协作）：对话旁边的一块编辑区。她写的文档或代码放在这里，你和她一起改。
//   桌面：对话页右侧分栏（标题栏的 Canvas 按钮开关，记在本机；她在这个会话里新建 canvas 时自动打开）；窗口太窄时面板占满主区，点「回到对话」回去。
//   手机：Canvas 按钮推入一个全屏页。
//   - 文档（Markdown）在「预览」（RichMarkdown 渲染）与「编辑」之间切换；代码直接编辑，等宽、轻量高亮（code_highlight.dart）。
//   - 保存（按钮或 Ctrl+S）就是一个新版本；她改了而你没在编辑时立即刷新，你正在编辑时顶部提示「她改过」，可以载入她的版本或保存你的
//     （保存时她也改过，你的存为最新、她的那版在版本历史里）。版本历史可以回看、恢复。复制、导出为文件。
//   - 运行（Python / JavaScript / TypeScript / shell / PowerShell）：在运行基座上、与她的命令同一个沙箱里执行，按「执行命令」权限过闸门；
//     退出码、stdout、stderr 与生成的图片显示在面板底部，她下一轮也看得到。
//   - 评论：在编辑里选中一段（预览里选中的文字会在原文里找）加评论，缺省作为对话里的一条消息发给她；可以回复、解决、采纳她的编辑建议，
//     内容变了以后评论按原文重新定位，原文改掉了标为「过时」。她修改或评论时 Canvas 按钮上有角标。
//   数据来源是 CanvasBackend（缺省经网关：canvas.* 方法与 canvas.changed 推送），测试里换成假的。
import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../api.dart';
import '../code_highlight.dart';
import '../markdown.dart';
import '../widgets.dart';

/// 面板的数据来源：运行基座的 canvas.* 方法与 canvas.changed 推送。
abstract class CanvasBackend {
  Future<T> call<T>(String method, [Map<String, dynamic>? params]);
  Stream<Map> get changes;
}

class ApiCanvasBackend implements CanvasBackend {
  const ApiCanvasBackend();
  @override
  Future<T> call<T>(String method, [Map<String, dynamic>? params]) => api.call<T>(method, params);
  @override
  Stream<Map> get changes => api.events.where((e) => e.name == 'canvas.changed' && e.data is Map).map((e) => e.data as Map);
}

/// 当前的数据来源（测试里替换）。
CanvasBackend canvasBackend = const ApiCanvasBackend();

const runnable = {'python', 'javascript', 'typescript', 'shell', 'powershell'};
const langs = ['python', 'javascript', 'typescript', 'shell', 'powershell', 'dart', 'go', 'rust', 'java', 'c', 'sql', 'yaml', 'json', 'html', 'css'];

/// 导出的扩展名。
String canvasExt(Map d) => d['kind'] != 'code' ? 'md' : const {'python': 'py', 'javascript': 'js', 'typescript': 'ts', 'shell': 'sh', 'powershell': 'ps1', 'rust': 'rs', 'yaml': 'yml'}['${d['lang']}'] ?? (('${d['lang']}').isEmpty ? 'txt' : '${d['lang']}');

/// 她的新动作（新建、修改、评论、运行）的角标：按会话计数，打开面板时清零。
class CanvasNotices extends ChangeNotifier {
  CanvasNotices._();
  static CanvasNotices? _i;
  static CanvasNotices get instance => _i ??= (CanvasNotices._().._listen());
  /// 测试用：换了数据来源后重新监听。
  static void reset() { _i?._sub?.cancel(); _i = null; }
  final unread = <String, int>{};
  final visible = <String>{}; // 此刻打开着面板的会话（不计角标）
  final _created = StreamController<Map>.broadcast();
  /// 她在某个会话里新建了 canvas（桌面据此自动打开分栏）。
  Stream<Map> get created => _created.stream;
  StreamSubscription? _sub;
  void _listen() {
    _sub = canvasBackend.changes.listen((e) {
      final conv = '${e['conv'] ?? ''}';
      if (e['author'] == 'agent' && e['kind'] == 'created') _created.add(e);
      if (e['author'] != 'agent' || !{'created', 'edited', 'comment', 'run'}.contains(e['kind']) || visible.contains(conv)) return;
      unread[conv] = (unread[conv] ?? 0) + 1;
      notifyListeners();
    });
  }
  int of(String conv) => unread[conv] ?? 0;
  void seen(String conv) { if (unread.remove(conv) != null) notifyListeners(); }
}

/// 桌面：对话旁的 Canvas 分栏开着没有（记在本机）。
final canvasShown = ValueNotifier<bool>(false);
bool _shownLoaded = false;
Future<void> _loadShown() async {
  if (_shownLoaded) return;
  _shownLoaded = true;
  try { final p = await SharedPreferences.getInstance(); canvasShown.value = p.getBool('canvas.shown') ?? false; } catch (_) {}
}
Future<void> setCanvasShown(bool v) async {
  canvasShown.value = v;
  try { (await SharedPreferences.getInstance()).setBool('canvas.shown', v); } catch (_) {}
}

/// 对话标题栏里的 Canvas 按钮：桌面开关右侧分栏，手机推入全屏页；她有新动作时带角标。
class CanvasButton extends StatelessWidget {
  final String conv;
  final double? size;
  const CanvasButton({super.key, required this.conv, this.size});
  @override
  Widget build(BuildContext context) {
    final n = CanvasNotices.instance;
    return ListenableBuilder(listenable: Listenable.merge([n, canvasShown]), builder: (context, _) {
      final desktop = ShellScope.isDesktop(context);
      final on = desktop && canvasShown.value;
      return IconButton(
        tooltip: on ? '收起 Canvas' : 'Canvas',
        isSelected: on,
        icon: Badge(isLabelVisible: n.of(conv) > 0, label: Text('${n.of(conv)}'), child: Icon(on ? Icons.article : Icons.article_outlined, size: size)),
        onPressed: () {
          n.seen(conv);
          if (desktop) { setCanvasShown(!canvasShown.value); return; }
          Navigator.push(context, MaterialPageRoute(builder: (_) => CanvasPage(conv: conv)));
        },
      );
    });
  }
}

/// 手机：一个会话的 Canvas 全屏页。
class CanvasPage extends StatelessWidget {
  final String conv;
  final CanvasBackend? backend;
  const CanvasPage({super.key, required this.conv, this.backend});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('Canvas')), body: CanvasPanel(conv: conv, backend: backend));
}

/// 桌面：对话与 Canvas 分栏。窗口够宽并排，不够宽时面板占满（带「回到对话」）。她在这个会话里新建 canvas 时自动打开。
class CanvasSplit extends StatefulWidget {
  final String conv;
  final Widget child;
  const CanvasSplit({super.key, required this.conv, required this.child});
  @override
  State<CanvasSplit> createState() => _CanvasSplitState();
}

class _CanvasSplitState extends State<CanvasSplit> {
  StreamSubscription? sub;
  double ratio = 0.5;
  @override
  void initState() {
    super.initState();
    _loadShown();
    sub = CanvasNotices.instance.created.listen((e) { if (e['conv'] == widget.conv && !canvasShown.value) setCanvasShown(true); });
  }
  @override
  void dispose() { sub?.cancel(); super.dispose(); }
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<bool>(valueListenable: canvasShown, builder: (context, shown, _) {
        if (!shown) return widget.child;
        return LayoutBuilder(builder: (context, box) {
          final cs = Theme.of(context).colorScheme;
          if (box.maxWidth < 760) {
            return Column(children: [
              Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => setCanvasShown(false), icon: const Icon(Icons.chat_bubble_outline, size: 16), label: const Text('回到对话'))),
              Expanded(child: CanvasPanel(conv: widget.conv)),
            ]);
          }
          final w = (box.maxWidth * ratio).clamp(340.0, box.maxWidth - 380);
          return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(child: widget.child),
            MouseRegion(
              cursor: SystemMouseCursors.resizeLeftRight,
              child: GestureDetector(
                behavior: HitTestBehavior.translucent,
                onHorizontalDragUpdate: (d) => setState(() => ratio = ((w - d.delta.dx) / box.maxWidth).clamp(0.3, 0.75)),
                child: SizedBox(width: 9, child: Center(child: Container(width: 1, color: cs.outlineVariant.withValues(alpha: 0.5)))),
              ),
            ),
            SizedBox(width: w, child: CanvasPanel(conv: widget.conv)),
          ]);
        });
      });
}

/// 一个会话的 Canvas：选哪一份、预览 / 编辑、保存、运行、评论、版本历史。
class CanvasPanel extends StatefulWidget {
  final String conv;
  final CanvasBackend? backend;
  const CanvasPanel({super.key, required this.conv, this.backend});
  @override
  State<CanvasPanel> createState() => CanvasPanelState();
}

class CanvasPanelState extends State<CanvasPanel> {
  CanvasBackend get be => widget.backend ?? canvasBackend;
  List<Map> docs = [];
  String? sel;
  Map? view; // 当前这一份的完整视图（canvas.get）
  bool loading = true, editing = false, dirty = false, theirsNewer = false, running = false, showComments = false;
  String base = ''; // 编辑基于的版本 id
  String? error;
  Map? run; // 正在看的运行结果
  String previewSelection = '';
  final ctl = CodeController();
  final focus = FocusNode();
  StreamSubscription? sub;
  bool _settingText = false;

  @override
  void initState() {
    super.initState();
    CanvasNotices.instance.visible.add(widget.conv);
    CanvasNotices.instance.seen(widget.conv);
    ctl.addListener(_onText);
    sub = be.changes.where((e) => e['conv'] == widget.conv || e['doc'] == sel).listen(_onChange);
    _reload();
  }

  @override
  void didUpdateWidget(CanvasPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.conv != widget.conv) {
      CanvasNotices.instance.visible..remove(oldWidget.conv)..add(widget.conv);
      sub?.cancel();
      sub = be.changes.where((e) => e['conv'] == widget.conv || e['doc'] == sel).listen(_onChange);
      sel = null; view = null; dirty = false; run = null;
      _reload();
    }
  }

  @override
  void dispose() {
    CanvasNotices.instance.visible.remove(widget.conv);
    sub?.cancel();
    ctl.dispose();
    focus.dispose();
    super.dispose();
  }

  void _onText() {
    if (_settingText) return;
    final d = view != null && ctl.text != '${view!['content']}';
    if (d != dirty) setState(() => dirty = d);
  }

  void _setText(String t) {
    _settingText = true;
    final sel0 = ctl.selection;
    ctl.text = t;
    if (sel0.isValid && sel0.end <= t.length) ctl.selection = sel0;
    _settingText = false;
  }

  /// 重新取列表与选中的这一份。正在编辑（有没保存的改动）时不动编辑框，只更新评论与运行，并提示她改过。
  Future<void> _reload({String? select}) async {
    try {
      final list = (await be.call<List>('canvas.list', {'conv': widget.conv})).cast<Map>();
      if (!mounted) return;
      docs = list;
      final want = select ?? sel;
      sel = list.any((d) => d['id'] == want) ? want : (list.isNotEmpty ? '${list.first['id']}' : null);
      if (sel == null) { setState(() { view = null; loading = false; error = null; }); return; }
      final v = await be.call<Map>('canvas.get', {'id': sel});
      if (!mounted) return;
      setState(() {
        final switched = view?['id'] != v['id'];
        if (switched) { dirty = false; run = null; editing = v['kind'] == 'code'; }
        if (!dirty) { view = v; base = '${v['versionId']}'; _setText('${v['content']}'); theirsNewer = false; }
        else { theirsNewer = '${v['versionId']}' != base; view = {...v, 'content': view!['content'], 'versionId': view!['versionId']}; } // 编辑中：只更新评论与运行
        ctl.lang = v['kind'] == 'code' ? '${v['lang']}' : '';
        loading = false; error = null;
      });
    } catch (e) {
      if (mounted) setState(() { loading = false; error = '$e'; });
    }
  }

  void _onChange(Map e) {
    if (!mounted) return;
    if (e['kind'] == 'run' && e['doc'] == sel && e['run'] != null) { _reload().then((_) => _showRun('${e['run']}')); return; }
    _reload(select: e['kind'] == 'created' && e['author'] == 'agent' && !dirty ? '${e['doc']}' : null);
  }

  void _showRun(String id) {
    final r = ((view?['runs'] as List?) ?? []).cast<Map>().where((x) => x['id'] == id).firstOrNull;
    if (r != null && mounted) setState(() => run = r);
  }

  Future<void> save() async {
    if (view == null || !dirty) return;
    final r = await act(context, () => be.call<Map>('canvas.edit', {'id': sel, 'content': ctl.text, 'base': base}));
    if (r == null || !mounted) return;
    final v = r['canvas'] as Map;
    setState(() { view = v; base = '${v['versionId']}'; dirty = false; theirsNewer = false; });
    if (r['conflict'] == true) toast(context, '保存时她也改过：你的版本已存为最新，她的那版在版本历史里');
  }

  /// 放弃自己的改动，载入她的最新版本。
  Future<void> takeTheirs() async { setState(() { dirty = false; theirsNewer = false; }); await _reload(); }

  Future<void> runCode() async {
    if (view == null) return;
    if (dirty) await save();
    if (!mounted || dirty) return;
    setState(() => running = true);
    final r = await act(context, () => be.call<Map>('canvas.run', {'id': sel}));
    if (!mounted) return;
    setState(() { running = false; if (r != null) run = r; });
  }

  /// 选中的范围（原文里的位置）：编辑里是输入框的选区；预览里在原文里找选中的文字。
  ({int start, int end})? selection() {
    if (editing || view?['kind'] == 'code') {
      final s = ctl.selection;
      return s.isValid && !s.isCollapsed ? (start: s.start, end: s.end) : null;
    }
    final t = previewSelection.trim();
    if (t.isEmpty) return null;
    final i = '${view?['content']}'.indexOf(t);
    return i < 0 ? (start: -1, end: -1) : (start: i, end: i + t.length);
  }

  Future<void> addComment() async {
    final s = selection();
    if (s != null && s.start < 0) { toast(context, '预览里的文字和原文对不上（有 Markdown 标记）：切到「编辑」里选中原文再评论'); return; }
    if (dirty) await save();
    if (!mounted || dirty) return;
    final quote = s == null ? '' : '${view!['content']}'.substring(s.start, s.end);
    final r = await commentDialog(context, title: s == null ? '评论整份文档' : '评论选中的内容', quote: quote);
    if (r == null || !mounted) return;
    final ok = await act(context, () => be.call<Map>('canvas.comment', {'id': sel, 'text': r.text, 'send': r.send, 'start': ?s?.start, 'end': ?s?.end}), ok: r.send ? '评论已发给她' : '已加评论');
    if (ok != null && mounted) { setState(() => showComments = true); _reload(); }
  }

  Future<void> reply(Map t) async {
    final r = await commentDialog(context, title: '回复评论', quote: '${t['quote']}');
    if (r == null || !mounted) return;
    if (await act(context, () => be.call<Map>('canvas.reply', {'thread': t['id'], 'text': r.text, 'send': r.send})) != null) _reload();
  }

  Future<void> resolve(Map t, bool v) async { if (await act(context, () => be.call<Map>('canvas.resolve', {'thread': t['id'], 'resolved': v})) != null) _reload(); }

  Future<void> applySuggestion(Map t) async {
    if (dirty) { toast(context, '先保存或放弃你正在编辑的改动'); return; }
    if (await act(context, () => be.call<Map>('canvas.apply', {'thread': t['id']}), ok: '已采纳') != null) _reload();
  }

  /// 在编辑框里选中评论对应的原文。
  void reveal(Map t) {
    final at = t['at'] as Map? ?? {};
    final start = (at['start'] as num?)?.toInt() ?? 0, end = (at['end'] as num?)?.toInt() ?? 0;
    if (dirty || end > ctl.text.length) return;
    setState(() => editing = true);
    ctl.selection = TextSelection(baseOffset: start, extentOffset: end);
    focus.requestFocus();
  }

  Future<void> newCanvas() async {
    final r = await showDialog<Map<String, String>>(context: context, builder: (c) => const _NewCanvasDialog());
    if (r == null || !mounted) return;
    final v = await act(context, () => be.call<Map>('canvas.create', {'conv': widget.conv, ...r, 'content': ''}));
    if (v != null && mounted) { setState(() { dirty = false; editing = true; }); _reload(select: '${v['id']}'); }
  }

  Future<void> rename() async {
    final c = TextEditingController(text: '${view?['title'] ?? ''}');
    final t = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(
          title: const Text('改名'),
          content: TextField(controller: c, autofocus: true, onSubmitted: (v) => Navigator.pop(ctx, v)),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('确定'))],
        ));
    if (t == null || t.trim().isEmpty || !mounted) return;
    if (await act(context, () => be.call<Map>('canvas.update', {'id': sel, 'title': t.trim()})) != null) _reload();
  }

  Future<void> remove() async {
    if (!await confirm(context, '删除这份 canvas？', '「${view?['title']}」会从面板里移除（她也看不到了）。')) return;
    if (!mounted) return;
    if (await act(context, () => be.call<bool>('canvas.delete', {'id': sel})) != null) { setState(() { sel = null; view = null; dirty = false; }); _reload(); }
  }

  Future<void> copy() async {
    await Clipboard.setData(ClipboardData(text: ctl.text));
    if (mounted) toast(context, '已复制');
  }

  Future<void> export() async {
    final d = view;
    if (d == null) return;
    final name = '${'${d['title']}'.replaceAll(RegExp(r'[\\/:*?"<>|\s]+'), '-')}.${canvasExt(d)}';
    try {
      final saved = await FilePicker.saveFile(fileName: name, bytes: Uint8List.fromList(utf8.encode(ctl.text)), type: FileType.custom, allowedExtensions: [canvasExt(d)]);
      if (saved != null && mounted) toast(context, '已导出');
    } catch (e) {
      if (mounted) toast(context, '没能导出：$e');
    }
  }

  Future<void> history() async {
    final list = await act(context, () => be.call<List>('canvas.versions', {'id': sel}));
    if (list == null || !mounted) return;
    final picked = await showSheet<Map>(context, (c, scroll) => ListView(controller: scroll, shrinkWrap: true, children: [
          const ListTile(title: Text('版本历史')),
          for (final v in list.cast<Map>().reversed)
            ListTile(
              dense: true,
              title: Text('第 ${v['n']} 版 · ${v['author'] == 'agent' ? api.name : '你'} · ${hm(v['ts'] as num)}'),
              subtitle: Text('${v['note'] ?? ''}${v['note'] != null && '${v['note']}'.isNotEmpty ? ' · ' : ''}${v['size']} 字符'),
              onTap: () => Navigator.pop(c, v),
            ),
        ]), maxWidth: 520);
    if (picked == null || !mounted) return;
    final old = await act(context, () => be.call<Map>('canvas.get', {'id': sel, 'version': picked['n']}));
    if (old == null || !mounted) return;
    final restore = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
          title: Text('第 ${picked['n']} 版'),
          content: SizedBox(width: 640, height: 420, child: SingleChildScrollView(child: view?['kind'] == 'code'
              ? SelectableText('${old['content']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 13))
              : RichMarkdown('${old['content']}'))),
          actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('关闭')), FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('恢复到这一版'))],
        ));
    if (restore != true || !mounted) return;
    if (dirty) { toast(context, '先保存或放弃你正在编辑的改动'); return; }
    if (await act(context, () => be.call<Map>('canvas.restore', {'id': sel, 'version': picked['n']}), ok: '已恢复（存为一个新版本）') != null) _reload();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error != null) return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text('Canvas 取不到：$error', style: TextStyle(color: cs.error))));
    if (view == null) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(Icons.article_outlined, size: 40, color: cs.outline),
        const SizedBox(height: 8),
        Text('这个会话还没有 canvas', style: TextStyle(color: cs.outline)),
        const SizedBox(height: 4),
        Text('请她写文档或代码时放进 Canvas，或者自己新建一份', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: cs.outline)),
        const SizedBox(height: 12),
        FilledButton.tonalIcon(onPressed: newCanvas, icon: const Icon(Icons.add, size: 18), label: const Text('新建 canvas')),
      ]));
    }
    final v = view!;
    final code = v['kind'] == 'code';
    final threads = ((v['threads'] as List?) ?? []).cast<Map>();
    final open = threads.where((t) => t['resolved'] != true).length;
    return Shortcuts(
      shortcuts: const {SingleActivator(LogicalKeyboardKey.keyS, control: true): _SaveIntent(), SingleActivator(LogicalKeyboardKey.keyS, meta: true): _SaveIntent()},
      child: Actions(
        actions: {_SaveIntent: CallbackAction<_SaveIntent>(onInvoke: (_) { save(); return null; })},
        child: LayoutBuilder(builder: (context, box) {
          final side = showComments && box.maxWidth >= 680;
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _toolbar(context, v, code, open),
            Divider(height: 1, color: cs.outlineVariant.withValues(alpha: 0.4)),
            if (theirsNewer) Banner0(text: '${api.name}改过这份 canvas（你还有没保存的改动）', color: Colors.blueGrey, action: Row(mainAxisSize: MainAxisSize.min, children: [
              TextButton(onPressed: takeTheirs, child: const Text('载入她的版本')),
              FilledButton.tonal(onPressed: save, child: const Text('保存我的')),
            ])),
            Expanded(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Expanded(child: _content(context, v, code)),
              if (side) ...[VerticalDivider(width: 1, color: cs.outlineVariant.withValues(alpha: 0.4)), SizedBox(width: min(320, box.maxWidth * 0.4), child: _comments(context, threads))],
            ])),
            if (showComments && !side) SizedBox(height: min(280, box.maxHeight * 0.4), child: Column(children: [Divider(height: 1, color: cs.outlineVariant), Expanded(child: _comments(context, threads))])),
            if (run != null) _runPanel(context, run!, box.maxHeight),
          ]);
        }),
      ),
    );
  }

  Widget _toolbar(BuildContext context, Map v, bool code, int open) {
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final canRun = code && runnable.contains('${v['lang']}');
    return SizedBox(height: 48, child: Row(children: [
      const SizedBox(width: 8),
      Expanded(child: PopupMenuButton<String>(
        tooltip: '选择 canvas',
        onSelected: (id) { if (id == '+') { newCanvas(); return; } if (dirty) { toast(context, '先保存或放弃你正在编辑的改动'); return; } setState(() => sel = id); _reload(select: id); },
        itemBuilder: (_) => [
          for (final d in docs) PopupMenuItem(value: '${d['id']}', child: Text('${d['title']}${d['kind'] == 'code' ? ' · ${d['lang']}' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis)),
          const PopupMenuDivider(),
          const PopupMenuItem(value: '+', child: Row(children: [Icon(Icons.add, size: 18), SizedBox(width: 8), Text('新建 canvas')])),
        ],
        child: Row(children: [
          Flexible(child: Text('${v['title']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: t.titleSmall)),
          const SizedBox(width: 4),
          Text('第 ${v['version']} 版${dirty ? ' · 未保存' : ''}', style: t.labelSmall?.copyWith(color: dirty ? cs.primary : cs.outline)),
          Icon(Icons.arrow_drop_down, color: cs.outline),
        ]),
      )),
      if (!code) IconButton(tooltip: editing ? '预览' : '编辑', icon: Icon(editing ? Icons.visibility_outlined : Icons.edit_outlined, size: 20), onPressed: () => setState(() => editing = !editing)),
      if (dirty) IconButton(tooltip: '保存', icon: const Icon(Icons.save_outlined, size: 20), onPressed: save),
      if (canRun) IconButton(tooltip: '运行', icon: running ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.play_arrow, size: 22), onPressed: running ? null : runCode),
      IconButton(tooltip: '评论选中内容', icon: const Icon(Icons.add_comment_outlined, size: 20), onPressed: addComment),
      IconButton(tooltip: '评论', isSelected: showComments, icon: Badge(isLabelVisible: open > 0, label: Text('$open'), child: const Icon(Icons.forum_outlined, size: 20)), onPressed: () => setState(() => showComments = !showComments)),
      PopupMenuButton<String>(
        tooltip: '更多',
        onSelected: (k) {
          switch (k) {
            case 'history': history();
            case 'copy': copy();
            case 'export': export();
            case 'rename': rename();
            case 'delete': remove();
            case 'runs': setState(() => run = ((v['runs'] as List?) ?? []).cast<Map>().firstOrNull);
          }
        },
        itemBuilder: (_) => [
          const PopupMenuItem(value: 'history', child: Text('版本历史')),
          if (((v['runs'] as List?) ?? []).isNotEmpty) const PopupMenuItem(value: 'runs', child: Text('最近一次运行结果')),
          const PopupMenuItem(value: 'copy', child: Text('复制全文')),
          const PopupMenuItem(value: 'export', child: Text('导出为文件')),
          const PopupMenuItem(value: 'rename', child: Text('改名')),
          const PopupMenuItem(value: 'delete', child: Text('删除')),
        ],
      ),
    ]));
  }

  Widget _content(BuildContext context, Map v, bool code) {
    if (!code && !editing) {
      return SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
        child: SelectionArea(onSelectionChanged: (c) => previewSelection = c?.plainText ?? '', child: RichMarkdown(ctl.text, selectable: false)),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 12, 8),
      child: TextField(
        key: const ValueKey('canvas-editor'),
        controller: ctl, focusNode: focus, maxLines: null, expands: true, textAlignVertical: TextAlignVertical.top, keyboardType: TextInputType.multiline,
        style: code ? const TextStyle(fontFamily: 'monospace', fontSize: 13, height: 1.45) : Theme.of(context).textTheme.bodyMedium,
        decoration: InputDecoration(border: InputBorder.none, hintText: code ? '写代码…' : '写 Markdown…'),
      ),
    );
  }

  Widget _comments(BuildContext context, List<Map> threads) {
    final cs = Theme.of(context).colorScheme, t = Theme.of(context).textTheme;
    if (threads.isEmpty) return Center(child: Padding(padding: const EdgeInsets.all(16), child: Text('还没有评论。选中一段，点「评论选中内容」', textAlign: TextAlign.center, style: t.bodySmall?.copyWith(color: cs.outline))));
    final sorted = [...threads]..sort((a, b) => (a['resolved'] == true ? 1 : 0) - (b['resolved'] == true ? 1 : 0));
    String who(Object? a) => a == 'agent' ? api.name : '你';
    return ListView(padding: const EdgeInsets.all(8), children: [
      for (final th in sorted)
        Card(
          key: ValueKey('thread-${th['id']}'),
          elevation: 0,
          color: th['resolved'] == true ? cs.surfaceContainerLowest : cs.surfaceContainerLow,
          child: Padding(padding: const EdgeInsets.all(10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text(who(th['author']), style: t.labelMedium),
              const SizedBox(width: 6),
              Text(hm(th['ts'] as num), style: t.labelSmall?.copyWith(color: cs.outline)),
              const Spacer(),
              if (th['resolved'] == true) _chip(context, '已解决', cs.outline)
              else if ((th['at'] as Map?)?['status'] == 'stale') _chip(context, '过时', Colors.orange)
              else if ((th['at'] as Map?)?['status'] == 'moved') _chip(context, '已重新定位', cs.primary),
            ]),
            if ('${th['quote']}'.isNotEmpty) InkWell(
              onTap: () => reveal(th),
              child: Container(
                margin: const EdgeInsets.only(top: 6), padding: const EdgeInsets.fromLTRB(8, 4, 8, 4), width: double.infinity,
                decoration: BoxDecoration(border: Border(left: BorderSide(color: cs.outline, width: 3))),
                child: Text('${th['quote']}', maxLines: 3, overflow: TextOverflow.ellipsis, style: t.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
              ),
            ),
            Padding(padding: const EdgeInsets.only(top: 6), child: Text('${th['text']}')),
            if (th['suggestion'] != null) Container(
              margin: const EdgeInsets.only(top: 6), padding: const EdgeInsets.all(8), width: double.infinity,
              decoration: BoxDecoration(color: cs.primaryContainer.withValues(alpha: 0.4), borderRadius: BorderRadius.circular(6)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('建议改为', style: t.labelSmall?.copyWith(color: cs.primary)),
                Text('${th['suggestion']}', style: t.bodySmall),
                if (th['resolved'] != true) Align(alignment: Alignment.centerRight, child: TextButton(onPressed: () => applySuggestion(th), child: const Text('采纳'))),
              ]),
            ),
            for (final r in ((th['replies'] as List?) ?? []).cast<Map>())
              Padding(padding: const EdgeInsets.only(top: 6, left: 12), child: Text.rich(TextSpan(children: [
                TextSpan(text: '${who(r['author'])}：', style: t.labelMedium),
                TextSpan(text: '${r['text']}'),
              ]))),
            Row(mainAxisAlignment: MainAxisAlignment.end, children: [
              TextButton(onPressed: () => reply(th), child: const Text('回复')),
              TextButton(onPressed: () => resolve(th, th['resolved'] != true), child: Text(th['resolved'] == true ? '重新打开' : '解决')),
            ]),
          ])),
        ),
    ]);
  }

  Widget _chip(BuildContext context, String s, Color c) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(border: Border.all(color: c), borderRadius: BorderRadius.circular(8)),
        child: Text(s, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: c)),
      );

  Widget _runPanel(BuildContext context, Map r, double height) {
    final cs = Theme.of(context).colorScheme, t = Theme.of(context).textTheme;
    final mono = t.bodySmall?.copyWith(fontFamily: 'monospace');
    final images = ((r['images'] as List?) ?? []).cast<Map>();
    final code = (r['code'] as num?)?.toInt() ?? 0;
    return Container(
      constraints: BoxConstraints(maxHeight: max(160, height * 0.42)),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: cs.outlineVariant))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          const SizedBox(width: 12),
          Icon(code == 0 ? Icons.check_circle_outline : Icons.error_outline, size: 16, color: code == 0 ? Colors.green : cs.error),
          const SizedBox(width: 6),
          Expanded(child: Text('运行结果 · 退出码 $code · ${(((r['ms'] as num?) ?? 0) / 1000).toStringAsFixed(1)} 秒${r['by'] == 'agent' ? ' · ${api.name}运行的' : ''}', style: t.labelMedium)),
          IconButton(tooltip: '关闭运行结果', icon: const Icon(Icons.close, size: 18), onPressed: () => setState(() => run = null)),
        ]),
        Flexible(child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(12, 0, 12, 12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if ('${r['out']}'.trim().isNotEmpty) SelectableText('${r['out']}', style: mono),
          if ('${r['err']}'.trim().isNotEmpty) SelectableText('${r['err']}', style: mono?.copyWith(color: cs.error)),
          if ('${r['out']}'.trim().isEmpty && '${r['err']}'.trim().isEmpty) Text('（没有输出）', style: t.bodySmall?.copyWith(color: cs.outline)),
          for (final img in images) Padding(padding: const EdgeInsets.only(top: 8), child: _RunImage(be: be, run: '${r['id']}', name: '${img['name']}', mime: '${img['mime']}')),
        ]))),
      ]),
    );
  }
}

class _SaveIntent extends Intent { const _SaveIntent(); }

/// 运行生成的一张图片：从运行的那具身体取来（canvas.runImage）；不在这具身体上时说明。
class _RunImage extends StatefulWidget {
  final CanvasBackend be;
  final String run, name, mime;
  const _RunImage({required this.be, required this.run, required this.name, required this.mime});
  @override
  State<_RunImage> createState() => _RunImageState();
}

class _RunImageState extends State<_RunImage> {
  late final Future<Map?> data = widget.be.call<Map?>('canvas.runImage', {'run': widget.run, 'name': widget.name});
  @override
  Widget build(BuildContext context) => FutureBuilder<Map?>(future: data, builder: (context, s) {
        final small = Theme.of(context).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.outline);
        if (s.connectionState != ConnectionState.done) return Text('${widget.name}（载入中）', style: small);
        final d = s.data;
        if (d == null) return Text('${widget.name}（在运行它的那具身体上，这里取不到）', style: small);
        final bytes = base64Decode('${d['data']}');
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.name, style: small),
          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 360), child: widget.mime == 'image/svg+xml' ? SvgPicture.memory(bytes) : Image.memory(bytes, fit: BoxFit.contain)),
        ]);
      });
}

/// 写评论 / 回复：文字与「发给她」（缺省勾选：作为对话里的一条消息发给她）。
Future<({String text, bool send})?> commentDialog(BuildContext context, {required String title, String quote = ''}) => showDialog(
      context: context,
      builder: (c) => _CommentDialog(title: title, quote: quote),
    );

class _CommentDialog extends StatefulWidget {
  final String title, quote;
  const _CommentDialog({required this.title, required this.quote});
  @override
  State<_CommentDialog> createState() => _CommentDialogState();
}

class _CommentDialogState extends State<_CommentDialog> {
  final text = TextEditingController();
  bool send = true;
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(width: 460, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (widget.quote.isNotEmpty) Container(
          padding: const EdgeInsets.fromLTRB(8, 4, 8, 4), margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(border: Border(left: BorderSide(color: cs.outline, width: 3))),
          child: Text(widget.quote, maxLines: 4, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.bodySmall),
        ),
        TextField(key: const ValueKey('comment-text'), controller: text, autofocus: true, minLines: 2, maxLines: 6, decoration: const InputDecoration(hintText: '写下你的意见', border: OutlineInputBorder())),
        CheckboxListTile(contentPadding: EdgeInsets.zero, value: send, onChanged: (v) => setState(() => send = v ?? true), title: const Text('发给她'), subtitle: const Text('作为对话里的一条消息，她会看到并回应'), controlAffinity: ListTileControlAffinity.leading),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () { if (text.text.trim().isNotEmpty) Navigator.pop(context, (text: text.text.trim(), send: send)); }, child: const Text('评论')),
      ],
    );
  }
}

class _NewCanvasDialog extends StatefulWidget {
  const _NewCanvasDialog();
  @override
  State<_NewCanvasDialog> createState() => _NewCanvasDialogState();
}

class _NewCanvasDialogState extends State<_NewCanvasDialog> {
  final title = TextEditingController();
  String kind = 'markdown', lang = 'python';
  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('新建 canvas'),
        content: SizedBox(width: 420, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          TextField(controller: title, autofocus: true, decoration: const InputDecoration(labelText: '标题')),
          const SizedBox(height: 12),
          SegmentedButton<String>(
            segments: const [ButtonSegment(value: 'markdown', label: Text('文档'), icon: Icon(Icons.article_outlined)), ButtonSegment(value: 'code', label: Text('代码'), icon: Icon(Icons.code))],
            selected: {kind}, onSelectionChanged: (s) => setState(() => kind = s.first),
          ),
          if (kind == 'code') Padding(padding: const EdgeInsets.only(top: 12), child: DropdownButtonFormField<String>(
                initialValue: lang, decoration: const InputDecoration(labelText: '语言'),
                items: [for (final l in langs) DropdownMenuItem(value: l, child: Text(runnable.contains(l) ? '$l（可运行）' : l))],
                onChanged: (v) => setState(() => lang = v ?? lang),
              )),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(context, {'title': title.text.trim().isEmpty ? '未命名' : title.text.trim(), 'kind': kind, if (kind == 'code') 'lang': lang}), child: const Text('新建')),
        ],
      );
}
