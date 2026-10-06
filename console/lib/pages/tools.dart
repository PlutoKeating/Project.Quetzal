// 控制 · 工具：她自己造的工具（实现在这具身体上）与灵魂仓库里的技能文档（随记忆同步，其他身体也能按文档实现）。
//   只看、停用 / 启用、删除；不在手机上编辑源码——有问题让她自己改（tool_write），或在「记忆历史」里撤销技能文档的变更。
import 'dart:convert';
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';

const _permissions = {'network': '联网', 'shell': '执行命令', 'device': '设备功能', 'camera': '相机', 'microphone': '麦克风', 'location': '定位', 'message': '主动发消息', 'self_modify': '修改自身参数', 'memory': '改写记忆', 'hands': '操作屏幕与应用', 'secret': '索取保密信息', 'tool_write': '造工具（写会被执行的代码）'};

class ToolsPage extends StatefulWidget {
  const ToolsPage({super.key});
  @override
  State<ToolsPage> createState() => _ToolsPageState();
}

class _ToolsPageState extends State<ToolsPage> {
  List<Map> tools = [], skills = [];
  bool loading = true;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('tools'));
    if (!mounted) return;
    setState(() { tools = (r?['tools'] as List? ?? []).cast<Map>(); skills = (r?['skills'] as List? ?? []).cast<Map>().where((s) => s['implemented'] != true).toList(); loading = false; });
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return PageFrame(
      title: '工具',
      body: loading ? const Center(child: CircularProgressIndicator()) : RefreshIndicator(onRefresh: _load, child: ListView(children: [
        if (tools.isEmpty && skills.isEmpty) Padding(padding: const EdgeInsets.all(32), child: Text('${api.name}还没有造过工具', textAlign: TextAlign.center)),
        for (final t in tools)
          Card(child: ListTile(
            leading: Icon(Icons.handyman, color: t['enabled'] == true && (t['missing'] as List).isEmpty ? cs.primary : cs.outline),
            title: Text('${t['name']}'),
            subtitle: Text('${plainPreview('${t['description']}')}\n${_permissions[t['permission']] ?? t['permission']} · ${t['runtime']} · ${t['timeout']}s${(t['missing'] as List).isNotEmpty ? ' · 缺 ${(t['missing'] as List).join('、')}' : ''}${t['enabled'] == true ? '' : ' · 已停用'}', maxLines: 3, overflow: TextOverflow.ellipsis),
            isThreeLine: true,
            trailing: Switch(value: t['enabled'] == true, onChanged: (v) async { await act(context, () => api.call('tools.toggle', {'name': t['name'], 'enabled': v})); _load(); }),
            onTap: () async { await Navigator.push(context, MaterialPageRoute(builder: (_) => ToolDetailPage(name: '${t['name']}'))); _load(); },
          )),
        if (skills.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 4), child: Text('只有技能文档', style: Theme.of(context).textTheme.labelLarge)),
        for (final s in skills)
          Card(child: ListTile(
            leading: Icon(Icons.description_outlined, color: cs.outline),
            title: Text('${s['name']}'), subtitle: Text(plainPreview('${s['description']}'), maxLines: 2, overflow: TextOverflow.ellipsis),
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ToolDetailPage(name: '${s['name']}'.replaceAll('-', '_'), skillOnly: true))),
          )),
      ])),
    );
  }
}

/// 一个工具：定义、源码、技能文档；删除（可连技能文档一起）。
class ToolDetailPage extends StatefulWidget {
  final String name;
  final bool skillOnly;
  const ToolDetailPage({super.key, required this.name, this.skillOnly = false});
  @override
  State<ToolDetailPage> createState() => _ToolDetailPageState();
}

class _ToolDetailPageState extends State<ToolDetailPage> {
  Map? t;
  String skill = '';
  bool loading = true;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map?>('tools.read', {'name': widget.name}));
    if (!mounted) return;
    setState(() { t = r; skill = '${r?['skill'] ?? ''}'; loading = false; });
  }

  @override
  Widget build(BuildContext context) {
    final th = Theme.of(context).textTheme;
    final m = (t?['manifest'] as Map?) ?? {};
    final impl = t?['manifest'] != null;
    return PageFrame(
      title: widget.name, actions: [
        if (impl) IconButton(tooltip: '删除', icon: const Icon(Icons.delete_outline), onPressed: () async {
          final also = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
            title: Text('删除工具 ${widget.name}？'),
            content: const Text('保留技能文档，别的设备仍能照着实现。'),
            actions: [TextButton(onPressed: () => Navigator.pop(x), child: const Text('取消')), TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('保留文档')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('全部删除'))],
          ));
          if (also == null || !context.mounted) return;
          final r = await act(context, () => api.call<String>('tools.delete', {'name': widget.name, 'skill': also}));
          if (r != null && context.mounted) { toast(context, r); Navigator.pop(context); }
        }),
      ],
      body: loading ? const Center(child: CircularProgressIndicator()) : ListView(padding: const EdgeInsets.all(16), children: [
        if (t == null) const Text('没有这个工具，也没有技能文档'),
        if (impl) ...[
          Text('${m['description']}', style: th.bodyLarge),
          const SizedBox(height: 6),
          Text('${_permissions[m['permission']] ?? m['permission']} · ${m['runtime']} · 超时 ${m['timeout']} 秒${(m['requires'] as List? ?? []).isNotEmpty ? ' · 依赖 ${(m['requires'] as List).join('、')}' : ''} · ${m['enabled'] == true ? '启用' : '已停用'}\n更新于 ${m['updatedAt']}', style: th.bodySmall),
          const SizedBox(height: 16),
          Text('参数', style: th.labelLarge),
          RawOrMarkdown('```json\n${_pretty(m['parameters'])}\n```'),
          const SizedBox(height: 16),
          Text(m['runtime'] == 'sh' ? 'tool.sh' : 'tool.mjs', style: th.labelLarge),
          RawOrMarkdown('```${m['runtime'] == 'sh' ? 'sh' : 'js'}\n${t!['source']}\n```'),
          const SizedBox(height: 16),
        ],
        Text('技能文档 SKILL.md', style: th.labelLarge),
        if (skill.isEmpty) Text('（没有技能文档）', style: th.bodySmall) else RichMarkdown(skill),
        const SizedBox(height: 24),
      ]),
    );
  }

  static String _pretty(Object? v) { try { return const JsonEncoder.withIndent('  ').convert(v); } catch (_) { return '$v'; } }
}
