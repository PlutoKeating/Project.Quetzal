// 模型：供应商、Key、模型选择与全局调用顺序。
// 交互参考 GoGoGo 管理后台：所有修改先进入本地草稿，底部保存栏统一「保存 / 放弃」；保存时带版本号，防止覆盖别处的修改。
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

class ProvidersPage extends StatefulWidget {
  const ProvidersPage({super.key});
  @override
  State<ProvidersPage> createState() => _ProvidersPageState();
}

class _ProvidersPageState extends State<ProvidersPage> {
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
    final picked = await showModalBottomSheet<Map>(context: context, isScrollControlled: true, builder: (_) => _ProviderPicker(load: _catalog));
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
    final keyCount = providers.fold<int>(0, (a, p) => a + (p['keys'] as List).length);
    return PopScope(
      canPop: !dirty,
      onPopInvokedWithResult: (didPop, _) async { if (!didPop && await confirm(context, '有未保存的修改', '离开将丢弃这些修改。') && context.mounted) { setState(() => draft = jsonDecode(jsonEncode(saved))); Navigator.pop(context); } },
      child: Scaffold(
        appBar: AppBar(title: const Text('模型'), actions: [IconButton(tooltip: '添加供应商', icon: const Icon(Icons.add), onPressed: _addProvider)]),
        body: saved == null ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.only(bottom: 100), children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              _Stat('${providers.length}', '供应商'), _Stat('$keyCount', '加密 Key'), _Stat('${ordered.length}', '已配置模型'),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: TextField(decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '按名称或 API 地址搜索已添加的供应商', border: OutlineInputBorder(), isDense: true), onChanged: (v) => setState(() => query = v)),
          ),
          if (providers.isEmpty) Padding(padding: const EdgeInsets.all(24), child: FilledButton.icon(onPressed: _addProvider, icon: const Icon(Icons.add), label: const Text('添加第一个供应商'))),
          for (final p in filtered) _ProviderCard(p: p, dirty: dirty, catalog: _catalog, onChanged: () => setState(() {}), nextOrder: () => _nextOrder,
              onRemove: () async { if (await confirm(context, '删除供应商', '删除「${p['name']}」及其所有 Key 与模型？（保存后生效）')) setState(() => providers.remove(p)); }),
          Section('全局模型顺序 · ${ordered.length}', [
            const Text('越靠上优先级越高，失败时依次尝试下一个。停用的供应商或没有启用 Key 的模型会被跳过。拖动右侧手柄排序。', style: TextStyle(fontSize: 12)),
            if (ordered.isEmpty) const Padding(padding: EdgeInsets.all(8), child: Text('还没有选择任何模型')),
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
                    subtitle: draft['quickModelId'] == ordered[i]['id'] ? const Text('内省用（便宜快速）') : null,
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      IconButton(tooltip: '设为内省模型', icon: Icon(draft['quickModelId'] == ordered[i]['id'] ? Icons.bolt : Icons.bolt_outlined), onPressed: () => setState(() => draft['quickModelId'] = draft['quickModelId'] == ordered[i]['id'] ? null : ordered[i]['id'])),
                      ReorderableDragStartListener(index: i, child: const Icon(Icons.drag_handle)),
                    ]),
                  ),
              ],
            ),
          ]),
        ]),
        bottomSheet: saved == null ? null : Material(
          elevation: 8,
          color: dirty ? Colors.orange.withValues(alpha: 0.15) : Theme.of(context).colorScheme.surfaceContainer,
          child: SafeArea(child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: Row(children: [
              Expanded(child: Text(dirty ? '有未保存的修改' : '配置已与 Amani 同步', style: const TextStyle(fontWeight: FontWeight.bold))),
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

class _Stat extends StatelessWidget {
  final String n, label;
  const _Stat(this.n, this.label);
  @override
  Widget build(BuildContext context) => Expanded(child: Card(margin: const EdgeInsets.all(4), child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(n, style: Theme.of(context).textTheme.headlineMedium?.copyWith(color: Theme.of(context).colorScheme.primary)), Text(label),
      ]))));
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

  Future<void> _addKey() async {
    final label = TextEditingController(text: keys.isEmpty ? 'prod' : 'key${keys.length + 1}'), secret = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
      title: const Text('添加 Key'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        TextField(controller: label, decoration: const InputDecoration(labelText: '标签')),
        TextField(controller: secret, obscureText: true, decoration: const InputDecoration(labelText: 'API Key')),
        const SizedBox(height: 8),
        const Text('保存后只显示末四位；密钥在设备上加密保存。', style: TextStyle(fontSize: 12)),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('添加'))],
    ));
    if (ok == true && secret.text.trim().length >= 8) { keys.add({'id': _uuid(), 'label': label.text.trim(), 'lastFour': '', 'enabled': true, 'secret': secret.text.trim()}); changed(); }
    else if (ok == true && mounted) { toast(context, 'Key 太短'); }
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
                PopupMenuItem(value: 'refresh', child: Text('刷新公共模型目录')),
                PopupMenuItem(value: 'remote', child: Text('从供应商接口获取模型（需已保存 Key）')),
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
          if (shown.isEmpty) const Text('没有可选模型：可刷新目录、从供应商接口获取，或添加自定义模型。', style: TextStyle(fontSize: 12)),
          const Divider(),
          TextButton(onPressed: widget.onRemove, child: const Text('删除供应商', style: TextStyle(color: Colors.red))),
        ],
      ),
    );
  }
}

class _ProviderPicker extends StatefulWidget {
  final Future<List> Function({bool refresh}) load;
  const _ProviderPicker({required this.load});
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
    return DraggableScrollableSheet(
      expand: false, initialChildSize: 0.85,
      builder: (_, scroll) => Column(children: [
        Padding(padding: const EdgeInsets.all(12), child: TextField(autofocus: true, decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: '搜索供应商（DeepSeek、OpenRouter、Anthropic…）', border: OutlineInputBorder()), onChanged: (v) => setState(() => q = v))),
        ListTile(leading: const Icon(Icons.edit), title: const Text('自定义供应商'), subtitle: const Text('任意 OpenAI 兼容 / Anthropic / Gemini 接口'), onTap: () => Navigator.pop(context, <String, dynamic>{})),
        const Divider(height: 1),
        Expanded(child: list == null
            ? Center(child: error != null ? Text(error!) : const CircularProgressIndicator())
            : ListView(controller: scroll, children: [
                for (final p in shown) ListTile(title: Text('${p['name']}'), subtitle: Text('${p['api']}\n${(p['models'] as List).length} 个模型 · ${protocols[p['protocol']] ?? p['protocol']}', maxLines: 2), onTap: () => Navigator.pop(context, p)),
              ])),
      ]),
    );
  }
}
