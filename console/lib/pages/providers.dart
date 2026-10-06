// 模型：默认只有「选一个供应商、粘贴 Key、接上」（运行基座 providers.quick 自动挑模型、试通、排好），已接上的一行一个。
// 完整管理（ProvidersEditor：多个 Key、手选模型、自定义供应商、全局顺序、内省模型）从右上角「编辑」进。
// 编辑器的交互参考 GoGoGo 管理后台：所有修改先进入本地草稿，底部保存栏统一「保存 / 放弃」；保存时带版本号，防止覆盖别处的修改。
import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';

const protocols = {
  'openai-completions': 'OpenAI 兼容（Chat Completions）',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Gemini',
};

String _uuid() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// 常用的供应商（公共目录里的 id → 显示的名字）；其余从「更多」里搜。
const _popular = {'deepseek': 'DeepSeek', 'moonshotai-cn': 'Kimi', 'zhipuai': '智谱', 'alibaba-cn': '阿里云百炼', 'siliconflow-cn': '硅基流动', 'volcengine': '火山方舟', 'openrouter': 'OpenRouter', 'openai': 'OpenAI', 'anthropic': 'Anthropic', 'google': 'Gemini'};

class ProvidersPage extends StatefulWidget {
  const ProvidersPage({super.key});
  @override
  State<ProvidersPage> createState() => _QuickPageState();
}

class _QuickPageState extends State<ProvidersPage> {
  List<Map> providers = [];
  bool loaded = false, busy = false, show = false;
  String pick = 'deepseek';
  String? pickName, error;
  List? catalog;
  final key = TextEditingController();

  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('providers'));
    if (!mounted || r == null) return;
    setState(() { providers = ((r['config'] as Map)['providers'] as List).cast<Map>(); loaded = true; });
  }
  Future<List> _catalog({bool refresh = false}) async => catalog ??= (await api.call<Map>('catalog'))['providers'] as List;

  Future<void> _more() async {
    final p = await showSheet<Map>(context, (_, scroll) => _ProviderPicker(load: _catalog, scroll: scroll), initial: 0.85);
    if (p == null || !mounted) return;
    if (p.isEmpty) return _edit(); // 自定义供应商：在编辑器里填
    setState(() { pick = '${p['id']}'; pickName = '${p['name']}'; });
  }
  Future<void> _edit() async { await Navigator.push(context, MaterialPageRoute(builder: (_) => const Material(child: ProvidersEditor()))); _load(); } // Material：从向导（根导航）进来时桌面版也有底色

  Future<void> _connect() async {
    final why = _ProviderCardState.keyProblem(key.text);
    if (why != null) { setState(() => error = why); return; }
    setState(() { busy = true; error = null; });
    try {
      final r = await api.call<Map>('providers.quick', {'catalogId': pick, 'key': key.text.trim()});
      if (!mounted) return;
      if (r['ok'] == true) { key.clear(); toast(context, '已接上 ${(r['models'] as List).join('、')}'); await api.refresh(); _load(); }
      else { setState(() => error = '${r['message']}'); }
    } catch (e) { if (mounted) setState(() => error = '$e'); }
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final names = {..._popular, if (pickName != null && !_popular.containsKey(pick)) pick: pickName!};
    return PageFrame(
      title: '模型',
      actions: [if (providers.isNotEmpty) TextButton(onPressed: _edit, child: const Text('编辑'))],
      body: !loaded ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(12), children: [
        if (providers.isNotEmpty) Card(child: Column(children: [
          for (final p in providers) ListTile(
            leading: Icon(Icons.circle, size: 10, color: p['enabled'] == true && (p['models'] as List).isNotEmpty ? Colors.green : cs.outline),
            title: Text('${p['name']}'),
            subtitle: (p['models'] as List).isEmpty ? null : Text((p['models'] as List).map((m) => m['name']).join('、'), maxLines: 1, overflow: TextOverflow.ellipsis),
            onTap: _edit,
          ),
        ])),
        Section(providers.isEmpty ? '接上一个模型' : '再接一个', [
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in names.entries) ChoiceChip(label: Text(e.value), selected: pick == e.key, onSelected: busy ? null : (_) => setState(() => pick = e.key)),
            ActionChip(label: const Text('更多'), onPressed: busy ? null : _more),
          ]),
          const SizedBox(height: 12),
          TextField(
            controller: key, obscureText: !show, autocorrect: false, enableSuggestions: false, enabled: !busy,
            onSubmitted: (_) => _connect(),
            decoration: InputDecoration(labelText: 'API Key', border: const OutlineInputBorder(),
                suffixIcon: IconButton(tooltip: show ? '隐藏' : '显示', icon: Icon(show ? Icons.visibility_off : Icons.visibility), onPressed: () => setState(() => show = !show))),
          ),
          if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: TextStyle(color: cs.error))),
          const SizedBox(height: 12),
          Row(children: [
            FilledButton(onPressed: busy ? null : _connect, child: const Text('接上')),
            if (busy) ...[const SizedBox(width: 12), const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)), const SizedBox(width: 8), Text('正在试…', style: t.bodySmall)],
          ]),
        ]),
      ]),
    );
  }
}

/// 完整的供应商管理：多个 Key、手选模型、自定义供应商、全局顺序与内省模型。
class ProvidersEditor extends StatefulWidget {
  const ProvidersEditor({super.key});
  @override
  State<ProvidersEditor> createState() => _ProvidersPageState();
}

class _ProvidersPageState extends State<ProvidersEditor> {
  Map? saved; // 服务器上的配置
  Map draft = {'providers': []};
  String version = '';
  bool busy = false;
  String query = '';
  List? catalog;

  bool get dirty => jsonEncode(draft) != jsonEncode(saved);
  List get providers => draft['providers'] as List;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('providers'));
    if (!mounted || r == null) return;
    setState(() { saved = r['config'] as Map; draft = jsonDecode(jsonEncode(saved)); version = r['version'] as String; });
  }

  Future<List> _catalog({bool refresh = false}) async {
    if (catalog != null && !refresh) return catalog!;
    final r = await api.call<Map>(refresh ? 'refreshCatalog' : 'catalog');
    return catalog = r['providers'] as List;
  }

  Future<void> _save() async {
    setState(() => busy = true);
    final r = await act(context, () => api.call<Map>('saveProviders', {'config': draft, 'expected': version}), ok: '已保存');
    if (r != null && mounted) setState(() { saved = r['config'] as Map; draft = jsonDecode(jsonEncode(saved)); version = r['version'] as String; });
    if (mounted) setState(() => busy = false);
  }

  List<Map> get _orderedModels {
    final all = <Map>[];
    for (final p in providers) { for (final m in (p['models'] as List)) { all.add({...m as Map, '_p': p}); } }
    all.sort((a, b) => (a['sortOrder'] as num).compareTo(b['sortOrder'] as num));
    return all;
  }

  int get _nextOrder => _orderedModels.fold<int>(-1, (a, m) => max(a, (m['sortOrder'] as num).toInt())) + 1;

  Future<void> _addProvider() async {
    final picked = await showSheet<Map>(context, (_, scroll) => _ProviderPicker(load: _catalog, scroll: scroll), initial: 0.85);
    if (picked == null) return;
    setState(() => providers.add({
      'id': _uuid(), 'catalogId': picked['id'] ?? 'custom', 'name': picked['name'] ?? '自定义供应商', 'baseUrl': picked['api'] ?? 'https://',
      'protocol': picked['protocol'] ?? 'openai-completions', 'enabled': true, 'keys': [], 'models': [],
    }));
  }

  @override
  Widget build(BuildContext context) {
    final filtered = providers.where((p) => query.isEmpty || '${p['name']} ${p['baseUrl']}'.toLowerCase().contains(query.toLowerCase())).toList();
    final ordered = _orderedModels;
    return PopScope(
      canPop: !dirty,
      onPopInvokedWithResult: (didPop, _) async { if (!didPop && await confirm(context, '有未保存的修改', '离开将丢弃这些修改。') && context.mounted) { setState(() => draft = jsonDecode(jsonEncode(saved))); Navigator.pop(context); } },
      child: PageFrame(
        title: '编辑模型', actions: [IconButton(tooltip: '添加供应商', icon: const Icon(Icons.add), onPressed: _addProvider)],
        body: saved == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.only(bottom: 100), children: [
          if (providers.length > 5) Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '搜索', border: OutlineInputBorder(), isDense: true), onChanged: (v) => setState(() => query = v)),
          ),
          if (providers.isEmpty) Padding(padding: const EdgeInsets.all(24), child: FilledButton.icon(onPressed: _addProvider, icon: const Icon(Icons.add), label: const Text('添加供应商'))),
          for (final p in filtered) _ProviderCard(p: p, dirty: dirty, catalog: _catalog, onChanged: () => setState(() {}), nextOrder: () => _nextOrder,
              onRemove: () async { if (await confirm(context, '删除供应商', '删除「${p['name']}」及其所有 Key 与模型？（保存后生效）')) setState(() => providers.remove(p)); }),
          if (ordered.isNotEmpty) Section('顺序', [
            const Text('先用上面的，失败了换下一个', style: TextStyle(fontSize: 12)),
            ReorderableListView(
              shrinkWrap: true, physics: const NeverScrollableScrollPhysics(), buildDefaultDragHandles: false,
              onReorderItem: (a, b) => setState(() {
                final list = [...ordered];
                list.insert(b, list.removeAt(a));
                for (var i = 0; i < list.length; i++) { _modelRef(list[i])['sortOrder'] = i; }
              }),
              children: [
                for (var i = 0; i < ordered.length; i++)
                  ListTile(
                    key: ValueKey(ordered[i]['id']), dense: true,
                    leading: Text((i + 1).toString().padLeft(2, '0')),
                    title: Text('${ordered[i]['_p']['name']}/${ordered[i]['name']}', style: TextStyle(color: ordered[i]['enabled'] == true && ordered[i]['_p']['enabled'] == true ? null : Colors.grey)),
                    subtitle: draft['quickModelId'] == ordered[i]['id'] ? const Text('轻量任务用') : null,
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      IconButton(tooltip: '轻量任务用它', icon: Icon(draft['quickModelId'] == ordered[i]['id'] ? Icons.bolt : Icons.bolt_outlined), onPressed: () => setState(() => draft['quickModelId'] = draft['quickModelId'] == ordered[i]['id'] ? null : ordered[i]['id'])),
                      ReorderableDragStartListener(index: i, child: const Icon(Icons.drag_handle)),
                    ]),
                  ),
              ],
            ),
          ]),
        ]),
        bottom: saved == null ? null : Material(
          elevation: 8,
          color: dirty ? Colors.orange.withValues(alpha: 0.15) : Theme.of(context).colorScheme.surfaceContainer,
          child: SafeArea(child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: Row(children: [
              Expanded(child: Text(dirty ? '有未保存的修改' : '已保存', style: const TextStyle(fontWeight: FontWeight.bold))),
              TextButton(onPressed: !dirty || busy ? null : () async { if (await confirm(context, '放弃修改', '丢弃所有未保存的修改？')) setState(() => draft = jsonDecode(jsonEncode(saved))); }, child: const Text('放弃')),
              FilledButton(onPressed: !dirty || busy ? null : _save, child: busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('保存')),
            ]),
          )),
        ),
      ),
    );
  }

  Map _modelRef(Map view) => ((view['_p'] as Map)['models'] as List).cast<Map>().firstWhere((m) => m['id'] == view['id']);
}

class _ProviderCard extends StatefulWidget {
  final Map p;
  final bool dirty;
  final Future<List> Function({bool refresh}) catalog;
  final VoidCallback onChanged, onRemove;
  final int Function() nextOrder;
  const _ProviderCard({required this.p, required this.dirty, required this.catalog, required this.onChanged, required this.onRemove, required this.nextOrder});
  @override
  State<_ProviderCard> createState() => _ProviderCardState();
}

class _ProviderCardState extends State<_ProviderCard> {
  String q = '';
  bool onlySelected = false;
  List<Map> candidates = []; // 可选模型：目录 + 供应商接口 + 已配置
  final tests = <String, String>{};

  Map get p => widget.p;
  List get keys => p['keys'] as List;
  List get models => p['models'] as List;
  void changed() { setState(() {}); widget.onChanged(); }

  @override
  void initState() { super.initState(); _loadCandidates(); }

  Future<void> _loadCandidates({bool refresh = false}) async {
    try {
      final cat = await widget.catalog(refresh: refresh);
      final entry = cat.cast<Map>().where((c) => c['id'] == p['catalogId']).firstOrNull;
      final list = <Map>[for (final m in (entry?['models'] as List? ?? [])) {'name': m['id'], 'label': m['name'], 'context': m['context'], 'output': m['output'], 'cost': m['cost'], 'tool': m['toolCall']}];
      if (mounted) setState(() => candidates = list);
    } catch (_) {}
  }

  Future<void> _fetchRemote() async {
    final names = await act(context, () => api.call<List>('remoteModels', {'providerId': p['id']}));
    if (names == null || !mounted) return;
    setState(() { for (final n in names) { if (!candidates.any((c) => c['name'] == n)) candidates.add({'name': n, 'label': n}); } });
    toast(context, '从供应商接口获取到 ${names.length} 个模型');
  }

  void _toggleModel(Map c, bool on) {
    if (on) {
      models.add({'id': _uuid(), 'name': c['name'], 'enabled': true, 'context': (c['context'] as num?)?.toInt() ?? 16000, 'maxTokens': min(((c['output'] as num?)?.toInt() ?? 4096), 16384).clamp(256, 128000), 'sortOrder': widget.nextOrder(), if (c['cost'] != null) 'cost': c['cost']});
    } else {
      models.removeWhere((m) => m['name'] == c['name']);
    }
    changed();
  }

  /// Key 的形状检查（与运行基座 registry.keyProblem 一致）：HTTP 头只能放 ASCII，粘错成聊天内容、带了空格换行时当场指出，不等到请求时报看不懂的错。
  static String? keyProblem(String raw) {
    final s = raw.trim();
    if (s.length < 8) return '太短，不像 API Key';
    final bad = RegExp(r'[^\x21-\x7e]').firstMatch(s);
    if (bad != null) {
      final c = bad.group(0)!;
      return RegExp(r'\s').hasMatch(c) ? 'Key 里有空格或换行，不像 API Key——是不是多复制了什么？' : 'Key 里有非 ASCII 字符（如「$c」），不像 API Key——是不是把别的文字粘进来了？';
    }
    return null;
  }

  Future<void> _addKey() async {
    final label = TextEditingController(text: keys.isEmpty ? 'prod' : 'key${keys.length + 1}'), secret = TextEditingController();
    var show = false;
    String? problem;
    final ok = await showDialog<bool>(context: context, builder: (x) => StatefulBuilder(builder: (x, setDialog) => AlertDialog(
      title: const Text('添加 Key'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: label, decoration: const InputDecoration(labelText: '标签')),
        // 默认遮挡，但可以点眼睛看一眼粘进来的是不是 Key（粘错成一句聊天是常见事故）
        TextField(
          controller: secret, obscureText: !show, autocorrect: false, enableSuggestions: false,
          onChanged: (v) => setDialog(() => problem = v.trim().isEmpty ? null : keyProblem(v)),
          decoration: InputDecoration(labelText: 'API Key', errorText: problem, errorMaxLines: 3,
              suffixIcon: IconButton(tooltip: show ? '隐藏' : '显示', icon: Icon(show ? Icons.visibility_off : Icons.visibility), onPressed: () => setDialog(() => show = !show))),
        ),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('添加'))],
    )));
    if (ok != true) return;
    final why = keyProblem(secret.text);
    if (why != null) { if (mounted) toast(context, why); return; }
    keys.add({'id': _uuid(), 'label': label.text.trim(), 'lastFour': '', 'enabled': true, 'secret': secret.text.trim()}); changed();
  }

  Future<void> _customModel() async {
    final name = TextEditingController(), ctx = TextEditingController(text: '128000'), out = TextEditingController(text: '8192');
    final ok = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
      title: const Text('自定义模型'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, decoration: const InputDecoration(labelText: '模型 ID')),
        TextField(controller: ctx, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '上下文长度')),
        TextField(controller: out, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '最大输出 token')),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('添加'))],
    ));
    if (ok == true && name.text.trim().isNotEmpty) {
      final c = {'name': name.text.trim(), 'label': name.text.trim(), 'context': int.tryParse(ctx.text) ?? 16000, 'output': int.tryParse(out.text) ?? 4096};
      if (!candidates.any((x) => x['name'] == c['name'])) candidates.insert(0, c);
      _toggleModel(c, true);
    }
  }

  Future<void> _editProvider() async {
    final name = TextEditingController(text: p['name']), url = TextEditingController(text: p['baseUrl']);
    String proto = p['protocol'];
    final ok = await showDialog<bool>(context: context, builder: (x) => StatefulBuilder(builder: (x, set) => AlertDialog(
      title: const Text('编辑供应商'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: name, decoration: const InputDecoration(labelText: '名称')),
        TextField(controller: url, decoration: const InputDecoration(labelText: 'API 地址（含版本路径，如 /v1）')),
        DropdownButtonFormField<String>(initialValue: proto, isExpanded: true, decoration: const InputDecoration(labelText: '协议'),
            items: [for (final e in protocols.entries) DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis))], onChanged: (v) => set(() => proto = v!)),
        if (keys.any((k) => k['secret'] == null)) const Padding(padding: EdgeInsets.only(top: 8), child: Text('修改 API 地址前需要先移除已保存的 Key，避免旧凭据被发往新地址。', style: TextStyle(fontSize: 12, color: Colors.orange))),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('确定'))],
    )));
    if (ok == true) { p['name'] = name.text.trim(); p['baseUrl'] = url.text.trim(); p['protocol'] = proto; changed(); }
  }

  @override
  Widget build(BuildContext context) {
    final selected = {for (final m in models) m['name']};
    final shown = [
      ...models.where((m) => !candidates.any((c) => c['name'] == m['name'])).map((m) => {'name': m['name'], 'label': m['name'], 'context': m['context']}),
      ...candidates,
    ].where((c) => (!onlySelected || selected.contains(c['name'])) && (q.isEmpty || '${c['name']} ${c['label']}'.toLowerCase().contains(q.toLowerCase()))).take(80).toList();
    return Card(
      child: ExpansionTile(
        leading: CircleAvatar(child: Text('${p['name']}'.isEmpty ? '?' : '${p['name']}'.substring(0, 1).toUpperCase())),
        title: Text('${p['name']}'),
        subtitle: Text('${keys.length} 个 Key · 已选 ${models.length} 个模型'),
        trailing: Chip(label: Text(p['enabled'] == true ? '已启用' : '已停用'), visualDensity: VisualDensity.compact),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Expanded(child: Text('${p['baseUrl']}\n${protocols[p['protocol']] ?? p['protocol']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
            TextButton(onPressed: _editProvider, child: const Text('编辑')),
          ]),
          SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('启用供应商'), value: p['enabled'] == true, onChanged: (v) { p['enabled'] = v; changed(); }),
          const Divider(),
          Row(children: [Text('API Keys · ${keys.length}', style: Theme.of(context).textTheme.titleSmall), const Spacer(), TextButton.icon(onPressed: _addKey, icon: const Icon(Icons.add), label: const Text('添加 Key'))]),
          for (final k in [...keys])
            ListTile(dense: true, contentPadding: EdgeInsets.zero,
              title: Text('${k['label']}'), subtitle: Text(k['secret'] != null ? '•••• ${'${k['secret']}'.substring('${k['secret']}'.length - 4)}（未保存）' : '•••• ${k['lastFour']}', style: const TextStyle(fontFamily: 'monospace')),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                Checkbox(value: k['enabled'] == true, onChanged: (v) { k['enabled'] = v; changed(); }),
                IconButton(icon: const Icon(Icons.delete_outline, color: Colors.red), onPressed: () async { if (await confirm(context, '移除 Key', '移除「${k['label']}」？（保存后生效）')) { keys.remove(k); changed(); } }),
              ])),
          const Divider(),
          Row(children: [
            Text('模型选择 · ${models.length}/${shown.length}', style: Theme.of(context).textTheme.titleSmall), const Spacer(),
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_horiz),
              onSelected: (v) { if (v == 'refresh') _loadCandidates(refresh: true); if (v == 'remote') _fetchRemote(); if (v == 'custom') _customModel(); },
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'refresh', child: Text('刷新目录')),
                PopupMenuItem(value: 'remote', child: Text('从供应商获取')),
                PopupMenuItem(value: 'custom', child: Text('自定义模型')),
              ],
            ),
          ]),
          Row(children: [
            Expanded(child: TextField(decoration: const InputDecoration(hintText: '搜索模型名称或 ID', isDense: true, prefixIcon: Icon(Icons.search)), onChanged: (v) => setState(() => q = v))),
            FilterChip(label: const Text('仅看已选'), selected: onlySelected, onSelected: (v) => setState(() => onlySelected = v)),
          ]),
          for (final c in shown)
            CheckboxListTile(
              dense: true, contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading,
              value: selected.contains(c['name']), onChanged: (v) => _toggleModel(c, v == true),
              title: Text('${c['label'] ?? c['name']}'),
              subtitle: Text('${c['name']}${c['context'] != null ? ' · ${((c['context'] as num) / 1000).round()}k 上下文' : ''}${tests[c['name']] != null ? '\n${tests[c['name']]}' : ''}', style: const TextStyle(fontSize: 11)),
              secondary: selected.contains(c['name'])
                  ? TextButton(
                      onPressed: widget.dirty ? null : () async {
                        setState(() => tests[c['name']] = '测试中…');
                        final r = await act(context, () => api.call<Map>('testModel', {'providerId': p['id'], 'model': c['name']}));
                        if (mounted) setState(() => tests[c['name']] = r == null ? '失败' : r['ok'] == true ? '✓ ${r['latencyMs']}ms：${r['message']}' : '✗ ${r['message']}');
                      },
                      child: Text(widget.dirty ? '先保存' : '测试'))
                  : null,
            ),
          if (shown.isEmpty) const Text('没有可选模型', style: TextStyle(fontSize: 12)),
          const Divider(),
          TextButton(onPressed: widget.onRemove, child: const Text('删除供应商', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
  }
}

class _ProviderPicker extends StatefulWidget {
  final Future<List> Function({bool refresh}) load;
  final ScrollController? scroll;
  const _ProviderPicker({required this.load, this.scroll});
  @override
  State<_ProviderPicker> createState() => _ProviderPickerState();
}

class _ProviderPickerState extends State<_ProviderPicker> {
  List? list;
  String q = '';
  String? error;
  @override
  void initState() { super.initState(); widget.load().then((l) => setState(() => list = l)).catchError((e) => setState(() => error = '$e')); }
  @override
  Widget build(BuildContext context) {
    final shown = (list ?? []).cast<Map>().where((p) => q.isEmpty || '${p['name']} ${p['id']}'.toLowerCase().contains(q.toLowerCase())).take(60).toList();
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.85,
      child: Column(children: [
        Padding(padding: const EdgeInsets.all(12), child: TextField(autofocus: true, decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '搜索', border: OutlineInputBorder()), onChanged: (v) => setState(() => q = v))),
        ListTile(leading: const Icon(Icons.edit), title: const Text('自定义'), onTap: () => Navigator.pop(context, <String, dynamic>{})),
        const Divider(height: 1),
        Expanded(child: list == null
            ? Center(child: error != null ? Text(error!) : const CircularProgressIndicator())
            : ListView(controller: widget.scroll, children: [
                for (final p in shown) ListTile(title: Text('${p['name']}'), subtitle: Text('${(p['models'] as List).length} 个模型'), onTap: () => Navigator.pop(context, p)),
              ])),
      ]),
    );
  }
}
