// 项目（#30）：把相关的会话组织在一起。名字、简介、项目说明（注入这个项目下所有会话的系统提示）、颜色与图标；
// 一个会话至多属于一个项目。这里是项目的缓存、编辑框、「移到项目」的选择框与管理面板，手机与桌面两种外壳共用。
// 旧版基座没有项目接口：supported 为假，界面不显示项目相关的入口。
import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';

/// 可选的颜色（#rrggbb，存进项目的 color）。
const projectColors = ['#e8875b', '#e0b252', '#7cb36b', '#4fb3a9', '#5b8fd6', '#9077d1', '#d16fa4', '#8a8f98'];

/// 可选的图标：存进项目的 icon 是这里的键；不认得的显示缺省图标。
const projectIcons = <String, IconData>{
  'folder': Icons.folder_outlined,
  'work': Icons.work_outline,
  'home': Icons.home_outlined,
  'school': Icons.school_outlined,
  'code': Icons.code,
  'flight': Icons.flight_takeoff,
  'favorite': Icons.favorite_border,
  'science': Icons.science_outlined,
  'music': Icons.music_note_outlined,
  'book': Icons.menu_book_outlined,
  'fitness': Icons.fitness_center,
  'money': Icons.savings_outlined,
};

Color projectColor(Map? p, ColorScheme cs) {
  final c = '${p?['color'] ?? ''}';
  if (RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(c)) return Color(int.parse('ff${c.substring(1)}', radix: 16));
  return cs.outline;
}

IconData projectIcon(Map? p) => projectIcons['${p?['icon'] ?? ''}'] ?? Icons.folder_outlined;

/// 项目的缓存：会话列表、选择框与管理面板共用；收到 projects 推送（本机或其他身体改了）就更新。
class ProjectStore extends ChangeNotifier {
  List<Map> items = []; // 现存的项目（含归档的）
  bool supported = true; // 连着的基座有没有项目接口
  StreamSubscription? _sub;

  void _listen() {
    _sub ??= api.events.where((e) => e.name == 'projects').listen((e) {
      if (e.data is List) { items = (e.data as List).cast<Map>(); supported = true; notifyListeners(); }
    });
  }

  Future<void> load() async {
    _listen();
    try {
      items = (await api.call<List>('projects')).cast<Map>();
      supported = true;
    } on RpcError catch (e) {
      if (e.code != 'OFFLINE' && e.code != 'TIMEOUT') supported = false; // 「未知操作」：旧版基座
    } catch (_) {}
    notifyListeners();
  }

  List<Map> get active => items.where((p) => p['archived'] != true).toList();
  Map? byId(String? id) { if (id == null || id.isEmpty) return null; for (final p in items) { if (p['id'] == id) return p; } return null; }

  /// 测试用：换掉缓存。
  void setForTest(List<Map> list, {bool supported = true}) { items = list; this.supported = supported; notifyListeners(); }
}

final projectStore = ProjectStore();

/// 新建或编辑一个项目；保存后返回它（取消返回 null）。
Future<Map?> editProject(BuildContext context, {Map? project}) async {
  final r = await showDialog<Map>(context: context, builder: (_) => _ProjectEditor(project: project));
  if (r != null) unawaited(projectStore.load());
  return r;
}

class _ProjectEditor extends StatefulWidget {
  final Map? project;
  const _ProjectEditor({this.project});
  @override
  State<_ProjectEditor> createState() => _ProjectEditorState();
}

class _ProjectEditorState extends State<_ProjectEditor> {
  late final name = TextEditingController(text: '${widget.project?['name'] ?? ''}');
  late final description = TextEditingController(text: '${widget.project?['description'] ?? ''}');
  late final instructions = TextEditingController(text: '${widget.project?['instructions'] ?? ''}');
  late String color = '${widget.project?['color'] ?? projectColors.first}';
  late String icon = '${widget.project?['icon'] ?? 'folder'}';
  bool saving = false;

  @override
  void dispose() { name.dispose(); description.dispose(); instructions.dispose(); super.dispose(); }

  Future<void> _save() async {
    if (name.text.trim().isEmpty) { toast(context, '项目要有名字'); return; }
    setState(() => saving = true);
    final body = {'name': name.text.trim(), 'description': description.text.trim(), 'instructions': instructions.text.trim(), 'color': color, 'icon': icon};
    final p = await act(context, () => widget.project == null ? api.call<Map>('projects.create', body) : api.call<Map>('projects.update', {'id': widget.project!['id'], ...body}));
    if (!mounted) return;
    setState(() => saving = false);
    if (p != null) Navigator.pop(context, p);
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return AlertDialog(
      title: Text(widget.project == null ? '新建项目' : '编辑项目'),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          TextField(key: const ValueKey('project-name'), controller: name, autofocus: widget.project == null, maxLength: 60, decoration: const InputDecoration(labelText: '名字')),
          TextField(controller: description, maxLength: 500, decoration: const InputDecoration(labelText: '简介（可选）')),
          TextField(key: const ValueKey('project-instructions'), controller: instructions, maxLength: 8000, minLines: 3, maxLines: 8,
              decoration: const InputDecoration(labelText: '项目说明（可选）', helperText: '这个项目下的每个会话她都会看到：背景、约定、要求', helperMaxLines: 2, alignLabelWithHint: true)),
          const SizedBox(height: 12),
          Text('颜色', style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 6),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final c in projectColors)
              InkWell(
                borderRadius: BorderRadius.circular(14),
                onTap: () => setState(() => color = c),
                child: Container(width: 28, height: 28, decoration: BoxDecoration(color: projectColor({'color': c}, cs), shape: BoxShape.circle, border: Border.all(color: color == c ? cs.onSurface : Colors.transparent, width: 2))),
              ),
          ]),
          const SizedBox(height: 12),
          Text('图标', style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 6),
          Wrap(spacing: 4, runSpacing: 4, children: [
            for (final e in projectIcons.entries)
              IconButton(isSelected: icon == e.key, onPressed: () => setState(() => icon = e.key), icon: Icon(e.value, color: icon == e.key ? projectColor({'color': color}, cs) : cs.onSurfaceVariant)),
          ]),
        ])),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: saving ? null : _save, child: const Text('保存')),
      ],
    );
  }
}

/// 「移到项目」：返回选中的项目 id；'' 为移出项目；取消返回 null。可以就地新建一个。
Future<String?> pickProject(BuildContext context, {String? current}) async {
  await projectStore.load();
  if (!context.mounted) return null;
  final r = await showDialog<String>(context: context, builder: (c) {
    final cs = Theme.of(c).colorScheme;
    return SimpleDialog(title: const Text('移到项目'), children: [
      for (final p in projectStore.active)
        ListTile(
          leading: Icon(projectIcon(p), color: projectColor(p, cs)),
          title: Text('${p['name']}', maxLines: 1, overflow: TextOverflow.ellipsis),
          trailing: p['id'] == current ? const Icon(Icons.check) : null,
          onTap: () => Navigator.pop(c, '${p['id']}'),
        ),
      ListTile(leading: const Icon(Icons.add), title: const Text('新建项目…'), onTap: () => Navigator.pop(c, '+new')),
      if (current != null && current.isNotEmpty)
        ListTile(leading: const Icon(Icons.folder_off_outlined), title: const Text('移出项目'), onTap: () => Navigator.pop(c, '')),
    ]);
  });
  if (r != '+new' || !context.mounted) return r;
  final p = await editProject(context);
  return p == null ? null : '${p['id']}';
}

/// 项目管理面板：新建、编辑、归档与找回、删除（删除不删会话，只解除归属）。
Future<void> showProjectManager(BuildContext context) async {
  await projectStore.load();
  if (!context.mounted) return;
  await showSheet(context, (c, scroll) => ProjectManager(scroll: scroll), initial: 0.7, maxWidth: 560);
}

class ProjectManager extends StatelessWidget {
  final ScrollController? scroll;
  const ProjectManager({super.key, this.scroll});

  Future<void> _delete(BuildContext context, Map p) async {
    if (!await confirm(context, '删除项目「${p['name']}」？', '项目下的会话不会被删除，只是不再属于这个项目。')) return;
    if (!context.mounted) return;
    final r = await act(context, () => api.call<Map>('projects.delete', {'id': p['id']}));
    if (r != null && context.mounted) toast(context, '已删除，${r['sessions'] ?? 0} 个会话移出了项目');
    await projectStore.load();
  }

  Future<void> _archive(BuildContext context, Map p, bool v) async {
    await act(context, () => api.call('projects.update', {'id': p['id'], 'archived': v}));
    await projectStore.load();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return ListenableBuilder(listenable: projectStore, builder: (context, _) {
      final list = [...projectStore.items]..sort((a, b) => (a['archived'] == true ? 1 : 0) - (b['archived'] == true ? 1 : 0));
      return Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 12, 4),
          child: Row(children: [
            Expanded(child: Text('项目', style: Theme.of(context).textTheme.titleMedium)),
            FilledButton.tonalIcon(onPressed: () => editProject(context), icon: const Icon(Icons.add), label: const Text('新建项目')),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Text('相关的会话放进同一个项目；项目说明会作为这个项目下所有会话的额外上下文交给她。', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: cs.outline)),
        ),
        const SizedBox(height: 8),
        Flexible(child: list.isEmpty
            ? Padding(padding: const EdgeInsets.all(32), child: Text('还没有项目', style: TextStyle(color: cs.outline)))
            : ListView(controller: scroll, shrinkWrap: true, children: [
                for (final p in list)
                  ListTile(
                    leading: Icon(projectIcon(p), color: projectColor(p, cs)),
                    title: Text('${p['name']}${p['archived'] == true ? '（已归档）' : ''}', maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: '${p['description'] ?? ''}'.isEmpty ? null : Text('${p['description']}', maxLines: 2, overflow: TextOverflow.ellipsis),
                    onTap: () => editProject(context, project: p),
                    trailing: PopupMenuButton<String>(
                      onSelected: (v) => switch (v) {
                        'edit' => editProject(context, project: p),
                        'archive' => _archive(context, p, true),
                        'restore' => _archive(context, p, false),
                        _ => _delete(context, p),
                      },
                      itemBuilder: (_) => [
                        const PopupMenuItem(value: 'edit', child: Text('编辑')),
                        PopupMenuItem(value: p['archived'] == true ? 'restore' : 'archive', child: Text(p['archived'] == true ? '找回' : '归档')),
                        const PopupMenuItem(value: 'delete', child: Text('删除')),
                      ],
                    ),
                  ),
              ])),
        const SizedBox(height: 12),
      ]);
    });
  }
}
