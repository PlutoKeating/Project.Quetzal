// 控制 · 高级 · 插件：她的工具来源（MCP）与插件。
//   - 她推荐的插件（plugin_recommend）在最上面，一键安装（先看清单再确认）；
//   - 工具来源：本机命令（stdio）或远程地址（Streamable HTTP / 旧版 SSE），启停、多端同步 / 仅本机、OAuth 登录（系统浏览器打开授权页，回调走运行基座的网关）、查看工具 / 资源 / 提示词、删除；
//   - 已装插件、推荐目录（基座内置的精选清单）、插件目录（Claude Code 插件市场格式），以及从本地目录或 git 仓库安装。
// 安装前总是先预览：将添加哪些工具来源、技能、命令与子 agent，要填哪些值；凭据输入遮挡，只存进运行基座的 secrets/，不再显示。
import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';
import '../links.dart';
import '../widgets.dart';

const _states = {'off': '已停用', 'starting': '连接中', 'auth': '需要登录', 'online': '已连接', 'error': '出错了', 'denied': '启动没被允许'};
String stateLabel(String? s) => _states[s] ?? '$s';
String _transport(String? t) => switch (t) { 'http' => '远程', 'sse' => '远程（SSE）', _ => '本机命令' };

class PluginsPage extends StatefulWidget {
  const PluginsPage({super.key});
  @override
  State<PluginsPage> createState() => _PluginsPageState();
}

class _PluginsPageState extends State<PluginsPage> with ReloadOnConnect {
  @override
  void reloadOnConnect() => _load();
  Map? sources, overview;
  StreamSubscription? sub;
  @override
  void initState() {
    super.initState();
    _load();
    sub = api.events.where((e) => e.name == 'plugins').listen((_) => _load());
  }
  @override
  void dispose() { sub?.cancel(); super.dispose(); }
  Future<void> _load() async {
    final r = await Future.wait([act(context, () => api.call<Map>('mcp.list')), act(context, () => api.call<Map>('plugins'))]);
    if (mounted) setState(() { sources = r[0] ?? sources ?? {}; overview = r[1] ?? overview ?? {}; });
  }

  Future<void> _preview(Map<String, dynamic> params) async {
    final p = await act(context, () => api.call<Map>('plugins.preview', params));
    if (p == null || !mounted) return;
    final done = await showSheet<bool>(context, (c, scroll) => InstallSheet(preview: p, scroll: scroll, onInstall: (inputs, enable, replace) => api.call('plugins.install', {'plan': p['plan'], 'inputs': inputs, 'enable': enable, 'replace': replace})), initial: 0.85);
    if (done != true) {
      unawaited(api.call('plugins.cancel', {'plan': p['plan']}).catchError((_) => false));
    } else if (mounted) {
      toast(context, '已安装 ${p['name']}');
    }
    _load();
  }

  Future<void> _fromSource() async {
    final c = TextEditingController();
    final v = await showDialog<String>(context: context, builder: (x) => AlertDialog(
      title: const Text('从目录或 git 仓库安装'),
      content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(hintText: '/path/to/plugin、https://…git 或 owner/repo', helperText: 'Claude Code 插件（.claude-plugin/plugin.json）或 Agent Skills 目录', helperMaxLines: 2)),
      actions: [TextButton(onPressed: () => Navigator.pop(x), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, c.text.trim()), child: const Text('预览'))],
    ));
    if (v != null && v.isNotEmpty) await _preview({'source': v});
  }

  Future<void> _addMarket() async {
    final c = TextEditingController();
    final v = await showDialog<String>(context: context, builder: (x) => AlertDialog(
      title: const Text('添加插件目录'),
      content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(hintText: 'owner/repo、https://…git 或 marketplace.json 的地址', helperText: 'Claude Code 插件市场格式（.claude-plugin/marketplace.json）', helperMaxLines: 2)),
      actions: [TextButton(onPressed: () => Navigator.pop(x), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, c.text.trim()), child: const Text('添加'))],
    ));
    if (v == null || v.isEmpty || !mounted) return;
    await act(context, () => api.call('plugins.marketplace.add', {'source': v}), ok: '已添加');
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return PageFrame(
      title: '插件',
      actions: [
        IconButton(tooltip: '添加工具来源', icon: const Icon(Icons.add_link), onPressed: () async {
          final ok = await showSheet<bool>(context, (c, scroll) => AddSourceSheet(scroll: scroll), initial: 0.85);
          if (ok == true) _load();
        }),
        PopupMenuButton<String>(tooltip: '更多', onSelected: (v) => v == 'source' ? _fromSource() : _addMarket(), itemBuilder: (_) => const [
          PopupMenuItem(value: 'source', child: Text('从目录或 git 仓库安装插件')),
          PopupMenuItem(value: 'market', child: Text('添加插件目录')),
        ]),
      ],
      body: sources == null || overview == null ? const Center(child: CircularProgressIndicator()) : RefreshIndicator(onRefresh: _load, child: PluginsBody(
        sources: sources!, overview: overview!,
        onPreview: _preview,
        onDismiss: (id) async { await act(context, () => api.call('plugins.dismiss', {'id': id})); _load(); },
        onToggle: (id, v) async { await act(context, () => api.call('mcp.update', {'id': id, 'enabled': v})); _load(); },
        onOpenSource: (id) async { await Navigator.push(context, MaterialPageRoute(builder: (_) => SourcePage(id: id))); _load(); },
        onUninstall: (name) async {
          if (!await confirm(context, '卸载 $name', '它加的工具来源（连同登录与凭据）和技能一起去掉；技能的历史在「记忆历史」里可找回。') || !context.mounted) return;
          await act(context, () => api.call('plugins.uninstall', {'name': name}), ok: '已卸载');
          _load();
        },
        onMarket: (name, action) async {
          if (action == 'remove' && (!await confirm(context, '去掉插件目录 $name', '已装的插件不受影响。') || !context.mounted)) return;
          await act(context, () => api.call(action == 'remove' ? 'plugins.marketplace.remove' : 'plugins.marketplace.refresh', {'name': name}), ok: action == 'remove' ? '已去掉' : '已刷新');
          _load();
        },
      )),
    );
  }
}

/// 插件页的内容（不碰网络，便于测试）。
class PluginsBody extends StatelessWidget {
  final Map sources, overview;
  final void Function(Map<String, dynamic> params) onPreview;
  final void Function(String id) onDismiss, onOpenSource, onUninstall;
  final void Function(String id, bool enabled) onToggle;
  final void Function(String name, String action) onMarket;
  const PluginsBody({super.key, required this.sources, required this.overview, required this.onPreview, required this.onDismiss, required this.onToggle, required this.onOpenSource, required this.onUninstall, required this.onMarket});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme, t = Theme.of(context).textTheme;
    final list = ((sources['sources'] as List?) ?? []).cast<Map>();
    final recs = ((overview['recommendations'] as List?) ?? []).cast<Map>();
    final installed = ((overview['installed'] as List?) ?? []).cast<Map>();
    final catalog = ((overview['catalog'] as List?) ?? []).cast<Map>();
    final markets = ((overview['marketplaces'] as List?) ?? []).cast<Map>();
    Widget head(String s, [String? note]) => Padding(padding: const EdgeInsets.fromLTRB(16, 18, 16, 4), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(s, style: t.labelLarge),
      if (note != null) Text(note, style: t.bodySmall?.copyWith(color: cs.onSurfaceVariant)),
    ]));
    return ListView(padding: const EdgeInsets.only(bottom: 32), children: [
      if ('${sources['error'] ?? ''}'.isNotEmpty) Card(color: cs.errorContainer, child: ListTile(leading: const Icon(Icons.error_outline), title: const Text('config/mcp.json 读不了'), subtitle: Text('${sources['error']}'))),
      if (recs.isNotEmpty) ...[
        head('${api.name.isEmpty ? '她' : api.name}推荐的', '装之前会列出它会加什么；装好后启动与每次调用仍按权限询问'),
        for (final r in recs) Card(child: ListTile(
          leading: Icon(Icons.recommend_outlined, color: cs.primary),
          title: Text('${r['name']}'),
          subtitle: Text('${r['reason']}'),
          trailing: Wrap(spacing: 4, children: [
            TextButton(onPressed: () => onDismiss('${r['id']}'), child: const Text('不用了')),
            FilledButton(onPressed: () { final id = '${r['id']}'; final i = id.indexOf('/'); onPreview(i < 0 ? {'catalog': id} : {'marketplace': id.substring(0, i), 'plugin': id.substring(i + 1)}); }, child: const Text('安装')),
          ]),
        )),
      ],
      head('工具来源', '${list.length} / ${sources['max'] ?? 32} 个 · 本机命令缺省只在这台设备上，远程来源缺省同步到她的其他身体（不含登录与凭据）'),
      if (list.isEmpty) Padding(padding: const EdgeInsets.all(16), child: Text('还没有。从下面的推荐目录装一个，或右上角添加。', style: t.bodySmall)),
      for (final s in list) SourceTile(source: s, onToggle: (v) => onToggle('${s['id']}', v), onTap: () => onOpenSource('${s['id']}')),
      if (installed.isNotEmpty) ...[
        head('已装插件'),
        for (final p in installed) Card(child: ListTile(
          leading: const Icon(Icons.extension),
          title: Text('${p['name']}${'${p['version'] ?? ''}'.isEmpty ? '' : '  ${p['version']}'}'),
          subtitle: Text([
            if ('${p['description'] ?? ''}'.isNotEmpty) '${p['description']}',
            [if ((p['mcp'] as List?)?.isNotEmpty == true) '工具来源 ${(p['mcp'] as List).join('、')}', if ((p['skills'] as List?)?.isNotEmpty == true) '技能 ${(p['skills'] as List).join('、')}', if ((p['commands'] as List?)?.isNotEmpty == true) '${(p['commands'] as List).length} 条命令', if ((p['agents'] as List?)?.isNotEmpty == true) '${(p['agents'] as List).length} 个子 agent'].join(' · '),
            '来自 ${p['source']}',
          ].where((x) => x.isNotEmpty).join('\n'), maxLines: 4, overflow: TextOverflow.ellipsis),
          isThreeLine: true,
          trailing: IconButton(tooltip: '卸载', icon: const Icon(Icons.delete_outline), onPressed: () => onUninstall('${p['name']}')),
        )),
      ],
      head('推荐目录', '基座内置的精选清单：官方与知名社区项目，注明来源与许可'),
      for (final e in catalog) Card(child: ListTile(
        leading: Icon(_categoryIcon('${e['category']}')),
        title: Text('${e['name']}'),
        subtitle: Text('${e['description']}\n${e['maintainer']} · ${e['license']} · ${e['transport'] == 'stdio' ? '本机运行' : '远程'}', maxLines: 4, overflow: TextOverflow.ellipsis),
        isThreeLine: true,
        trailing: e['installed'] == true ? const Text('已装') : FilledButton.tonal(onPressed: () => onPreview({'catalog': '${e['id']}'}), child: const Text('安装')),
        onLongPress: () => openExternal(context, '${e['source']}'),
      )),
      head('插件目录', '兼容 Claude Code 插件市场（marketplace.json）；右上角「添加插件目录」'),
      if (markets.isEmpty) Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text('还没有添加。', style: t.bodySmall)),
      for (final m in markets) Card(child: ExpansionTile(
        leading: const Icon(Icons.storefront_outlined),
        title: Text('${m['name']}'),
        subtitle: Text('${m['error'] ?? [if ('${m['owner'] ?? ''}'.isNotEmpty) '${m['owner']}', '${(m['plugins'] as List?)?.length ?? 0} 个插件'].join(' · ')}'),
        trailing: PopupMenuButton<String>(onSelected: (v) => onMarket('${m['name']}', v), itemBuilder: (_) => const [PopupMenuItem(value: 'refresh', child: Text('刷新')), PopupMenuItem(value: 'remove', child: Text('去掉'))]),
        children: [
          for (final p in ((m['plugins'] as List?) ?? []).cast<Map>()) ListTile(
            dense: true, title: Text('${p['name']}${'${p['version'] ?? ''}'.isEmpty ? '' : '  ${p['version']}'}'),
            subtitle: Text('${p['description'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis),
            trailing: p['installed'] == true ? const Text('已装') : TextButton(onPressed: () => onPreview({'marketplace': '${m['name']}', 'plugin': '${p['name']}'}), child: const Text('安装')),
          ),
        ],
      )),
    ]);
  }
}

IconData _categoryIcon(String c) => switch (c) {
  'browser' => Icons.public, 'email' => Icons.mail_outline, 'calendar' => Icons.event_outlined, 'dev' => Icons.code,
  'knowledge' => Icons.menu_book_outlined, 'files' => Icons.folder_outlined, _ => Icons.extension_outlined,
};

/// 一个工具来源：名字、方式、状态与工具数；开关启停。
class SourceTile extends StatelessWidget {
  final Map source;
  final void Function(bool enabled) onToggle;
  final VoidCallback onTap;
  const SourceTile({super.key, required this.source, required this.onToggle, required this.onTap});
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final s = source, state = '${s['state']}';
    final color = switch (state) { 'online' => cs.primary, 'auth' || 'error' || 'denied' => cs.error, _ => cs.outline };
    final counts = [if ((s['tools'] ?? 0) > 0) '${s['tools']} 个工具', if ((s['resources'] ?? 0) > 0) '${s['resources']} 个资源', if ((s['prompts'] ?? 0) > 0) '${s['prompts']} 个提示词'].join('、');
    final missing = (s['secrets'] as List?)?.isNotEmpty == true;
    return Card(child: ListTile(
      leading: Icon(s['transport'] == 'stdio' ? Icons.terminal : Icons.cloud_outlined, color: color),
      title: Text('${s['title']}'),
      subtitle: Text([
        '${_transport('${s['transport']}')} · ${stateLabel(state)}${counts.isEmpty ? '' : ' · $counts'} · ${s['sync'] == true ? '多端同步' : '仅本机'}',
        if (missing) '这台设备上还缺凭据',
        if ('${s['error'] ?? ''}'.isNotEmpty && state != 'online') '${s['error']}',
      ].join('\n'), maxLines: 3, overflow: TextOverflow.ellipsis),
      trailing: Switch(value: s['enabled'] == true, onChanged: onToggle),
      onTap: onTap,
    ));
  }
}

/// 安装前的清单：将加的工具来源（要填的值）、技能、命令与子 agent、提醒；确认后才安装。
class InstallSheet extends StatefulWidget {
  final Map preview;
  final ScrollController? scroll;
  final Future<dynamic> Function(Map<String, Map<String, String>> inputs, bool enable, bool replace) onInstall;
  const InstallSheet({super.key, required this.preview, required this.onInstall, this.scroll});
  @override
  State<InstallSheet> createState() => _InstallSheetState();
}

class _InstallSheetState extends State<InstallSheet> {
  final ctl = <String, TextEditingController>{};
  bool enable = true, busy = false;
  String error = '';
  TextEditingController _c(String server, String key) => ctl.putIfAbsent('$server\u0000$key', TextEditingController.new);
  @override
  void dispose() { for (final c in ctl.values) { c.dispose(); } super.dispose(); }

  Future<void> _go() async {
    final inputs = <String, Map<String, String>>{};
    for (final e in ctl.entries) {
      final [server, key] = e.key.split('\u0000');
      if (e.value.text.trim().isNotEmpty) (inputs[server] ??= {})[key] = e.value.text.trim();
    }
    setState(() { busy = true; error = ''; });
    try {
      await widget.onInstall(inputs, enable, widget.preview['installed'] != null);
      if (mounted) Navigator.pop(context, true);
    } catch (e) { if (mounted) setState(() { busy = false; error = '$e'; }); }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.preview, t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final mcp = ((p['mcp'] as List?) ?? []).cast<Map>();
    final skills = ((p['skills'] as List?) ?? []).cast<Map>();
    final commands = ((p['commands'] as List?) ?? []).cast<Map>(), agents = ((p['agents'] as List?) ?? []).cast<Map>();
    final warnings = ((p['warnings'] as List?) ?? []).cast<Object>();
    Widget label(String s) => Padding(padding: const EdgeInsets.only(top: 14, bottom: 4), child: Text(s, style: t.labelLarge));
    Widget note(IconData i, String s, [Color? c]) => Padding(padding: const EdgeInsets.only(top: 6), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Icon(i, size: 18, color: c ?? cs.onSurfaceVariant), const SizedBox(width: 8), Expanded(child: Text(s, style: t.bodySmall?.copyWith(color: c)))]));
    return ListView(controller: widget.scroll, padding: const EdgeInsets.fromLTRB(20, 20, 20, 24), children: [
      Text('安装 ${p['name']}${'${p['version'] ?? ''}'.isEmpty ? '' : '  ${p['version']}'}', style: t.titleLarge),
      if ('${p['description'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${p['description']}')),
      Padding(padding: const EdgeInsets.only(top: 6), child: Text([if ('${p['author'] ?? ''}'.isNotEmpty) '${p['author']}', if ('${p['license'] ?? ''}'.isNotEmpty) '${p['license']}', '来自 ${p['source']}'].join(' · '), style: t.bodySmall)),
      if ('${p['homepage'] ?? ''}'.startsWith('https://')) Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => openExternal(context, '${p['homepage']}'), icon: const Icon(Icons.open_in_new, size: 16), label: const Text('看来源'))),
      if (p['installed'] != null) note(Icons.update, '已经装了 ${p['installed']}：这次会更新它（工具来源的登录与凭据保留）'),
      if (mcp.isNotEmpty) label('将添加的工具来源'),
      for (final m in mcp) Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('${m['title']}（${m['id']}）', style: t.titleSmall),
        Text(m['transport'] == 'stdio' ? '本机命令：${m['command']} ${((m['args'] as List?) ?? []).join(' ')}' : '${_transport('${m['transport']}')}：${m['url']}${m['oauth'] == true ? '（需要时用 OAuth 登录）' : ''}', style: t.bodySmall),
        Text(m['sync'] == true ? '多端同步（不含凭据）' : '仅本机', style: t.bodySmall),
        if (m['problem'] != null) note(Icons.block, '这一项装不了：${m['problem']}', cs.error),
        if (m['problem'] == null) for (final i in ((m['inputs'] as List?) ?? []).cast<Map>()) Padding(padding: const EdgeInsets.only(top: 8), child: TextField(
          controller: _c('${m['key']}', '${i['key']}'),
          obscureText: i['secret'] == true,
          decoration: InputDecoration(labelText: '${i['label']}${i['required'] == true ? '' : '（可选）'}', hintText: i['placeholder'] == null ? null : '${i['placeholder']}', helperText: i['secret'] == true ? '只存在这台设备的运行基座里，不再显示' : null, isDense: true),
        )),
      ]))),
      if (skills.isNotEmpty) label('将写进灵魂仓库的技能（随她同步到其他身体）'),
      for (final s in skills) ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: Icon(s['conflict'] == null ? Icons.description_outlined : Icons.block, color: s['conflict'] == null ? null : cs.error),
        title: Text('${s['name']}'), subtitle: Text([if ('${s['description'] ?? ''}'.isNotEmpty) '${s['description']}', '${(s['files'] as List?)?.length ?? 0} 个文件${(s['skipped'] as List?)?.isNotEmpty == true ? '，跳过 ${(s['skipped'] as List).length} 个（程序与脚本不进灵魂仓库）' : ''}', if (s['conflict'] != null) '${s['conflict']}'].join('\n'))),
      if (commands.isNotEmpty || agents.isNotEmpty) label('命令与子 agent（留在这台设备上，她按需取用）'),
      for (final c in [...commands, ...agents]) Text('· ${c['name']}${'${c['description'] ?? ''}'.isEmpty ? '' : '：${c['description']}'}', style: t.bodySmall),
      if (p['outward'] != null) note(Icons.front_hand_outlined, '${p['outward']}'),
      if (p['setup'] != null) note(Icons.info_outline, '${p['setup']}'),
      for (final w in warnings) note(Icons.warning_amber, '$w'),
      if (mcp.isNotEmpty) SwitchListTile(contentPadding: EdgeInsets.zero, value: enable, onChanged: (v) => setState(() => enable = v), title: const Text('装好就启用'), subtitle: const Text('启动前仍会按权限问一次（缺省每次询问）')),
      if (error.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error, style: TextStyle(color: cs.error))),
      const SizedBox(height: 12),
      Row(mainAxisAlignment: MainAxisAlignment.end, children: [
        TextButton(onPressed: busy ? null : () => Navigator.pop(context, false), child: const Text('取消')),
        const SizedBox(width: 8),
        FilledButton(onPressed: busy ? null : _go, child: Text(busy ? '安装中…' : p['installed'] != null ? '更新' : '安装')),
      ]),
    ]);
  }
}

/// 添加一个工具来源：本机命令（绝对路径，经沙箱）或远程地址（HTTPS）。
class AddSourceSheet extends StatefulWidget {
  final ScrollController? scroll;
  const AddSourceSheet({super.key, this.scroll});
  @override
  State<AddSourceSheet> createState() => _AddSourceSheetState();
}

class _AddSourceSheetState extends State<AddSourceSheet> {
  String kind = 'http';
  bool sandbox = true, oauth = true, enable = true;
  final title = TextEditingController(), command = TextEditingController(), args = TextEditingController(), env = TextEditingController(),
      url = TextEditingController(), auth = TextEditingController();
  String error = '';
  @override
  void dispose() { for (final c in [title, command, args, env, url, auth]) { c.dispose(); } super.dispose(); }

  Future<void> _save() async {
    final remote = kind != 'stdio';
    final envMap = <String, String>{};
    for (final l in env.text.split('\n').map((x) => x.trim()).where((x) => x.isNotEmpty)) {
      final i = l.indexOf('=');
      if (i <= 0) { setState(() => error = '环境变量一行一个，写成 名字=值'); return; }
      envMap[l.substring(0, i).trim()] = l.substring(i + 1);
    }
    final server = <String, dynamic>{
      'title': title.text.trim().isEmpty ? (remote ? Uri.tryParse(url.text.trim())?.host ?? 'mcp' : command.text.trim().split('/').last) : title.text.trim(),
      'transport': kind, 'enabled': enable,
      if (remote) ...{'url': url.text.trim(), if (!oauth) 'oauth': false} else ...{'command': command.text.trim(), 'args': args.text.split('\n').map((x) => x.trim()).where((x) => x.isNotEmpty).toList(), 'env': envMap, 'sandbox': sandbox},
    };
    try {
      await api.call('mcp.add', {'server': server, if (remote && auth.text.trim().isNotEmpty) 'secrets': {'Authorization': auth.text.trim()}});
      if (mounted) Navigator.pop(context, true);
    } catch (e) { setState(() => error = '$e'); }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final remote = kind != 'stdio';
    return ListView(controller: widget.scroll, padding: const EdgeInsets.fromLTRB(20, 20, 20, 24), children: [
      Text('添加工具来源', style: t.titleLarge),
      const SizedBox(height: 12),
      SegmentedButton<String>(segments: const [ButtonSegment(value: 'http', label: Text('远程')), ButtonSegment(value: 'sse', label: Text('远程（旧版 SSE）')), ButtonSegment(value: 'stdio', label: Text('本机命令'))], selected: {kind}, onSelectionChanged: (s) => setState(() => kind = s.first)),
      TextField(controller: title, decoration: const InputDecoration(labelText: '名字（可选）')),
      if (remote) ...[
        TextField(controller: url, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: '地址', hintText: 'https://example.com/mcp', helperText: '只收 HTTPS（本机 127.0.0.1 除外）')),
        TextField(controller: auth, obscureText: true, decoration: const InputDecoration(labelText: 'Authorization 请求头（可选）', hintText: 'Bearer …', helperText: '有 API Key 时填；只存在这台设备上，不同步')),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: oauth, onChanged: (v) => setState(() => oauth = v), title: const Text('需要时用 OAuth 登录'), subtitle: const Text('服务要求登录时，在这里点「登录」，在浏览器里完成授权')),
      ] else ...[
        TextField(controller: command, decoration: const InputDecoration(labelText: '命令（绝对路径）', hintText: '/usr/bin/node')),
        TextField(controller: args, minLines: 2, maxLines: 6, decoration: const InputDecoration(labelText: '参数（一行一个）')),
        TextField(controller: env, minLines: 1, maxLines: 6, decoration: const InputDecoration(labelText: '环境变量（一行一个，名字=值）')),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: sandbox, onChanged: (v) => setState(() => sandbox = v), title: const Text('在沙箱里运行'), subtitle: const Text('关掉后它能读这台设备上你的一切文件')),
      ],
      SwitchListTile(contentPadding: EdgeInsets.zero, value: enable, onChanged: (v) => setState(() => enable = v), title: const Text('立即启用'), subtitle: const Text('启动前仍会按权限问一次')),
      if (error.isNotEmpty) Text(error, style: TextStyle(color: Theme.of(context).colorScheme.error)),
      const SizedBox(height: 8),
      Align(alignment: Alignment.centerRight, child: FilledButton(onPressed: _save, child: const Text('添加'))),
    ]);
  }
}

/// 一个工具来源的详情：状态、登录、同步方式，它提供的工具 / 资源 / 提示词；重新连接与删除。
class SourcePage extends StatefulWidget {
  final String id;
  const SourcePage({super.key, required this.id});
  @override
  State<SourcePage> createState() => _SourcePageState();
}

class _SourcePageState extends State<SourcePage> with ReloadOnConnect {
  @override
  void reloadOnConnect() => _load();
  Map? s;
  bool loading = true;
  StreamSubscription? sub;
  final pasted = TextEditingController();
  @override
  void initState() { super.initState(); _load(); sub = api.events.where((e) => e.name == 'plugins').listen((_) => _load()); }
  @override
  void dispose() { sub?.cancel(); pasted.dispose(); super.dispose(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map?>('mcp.detail', {'id': widget.id}));
    if (mounted) setState(() { s = r; loading = false; });
  }
  Future<void> _login() async {
    final r = await act(context, () => api.call<Map>('mcp.login', {'id': widget.id}));
    if (r == null || !mounted) return;
    if (r['authorized'] == true) { toast(context, '已登录'); return _load(); }
    await openExternal(context, '${r['url']}');
    if (mounted) toast(context, '在浏览器里完成授权；完成后这里会自动连上');
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final s = this.s, t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final c = (s?['contents'] as Map?) ?? {};
    Widget label(String x) => Padding(padding: const EdgeInsets.only(top: 18, bottom: 4), child: Text(x, style: t.labelLarge));
    return PageFrame(
      title: '${s?['title'] ?? widget.id}',
      actions: [
        if (s != null) IconButton(tooltip: '重新连接', icon: const Icon(Icons.refresh), onPressed: () async { await act(context, () => api.call('mcp.restart', {'id': widget.id})); _load(); }),
        if (s != null) IconButton(tooltip: '删除', icon: const Icon(Icons.delete_outline), onPressed: () async {
          if (!await confirm(context, '删除 ${s['title']}', s['sync'] == true ? '连同登录与凭据；她的其他身体上的这一项也会删除。' : '连同登录与凭据。') || !context.mounted) return;
          await act(context, () => api.call('mcp.remove', {'id': widget.id}), ok: '已删除');
          if (context.mounted) Navigator.pop(context);
        }),
      ],
      body: loading ? const Center(child: CircularProgressIndicator()) : s == null ? const Center(child: Text('没有这个来源')) : ListView(padding: const EdgeInsets.all(16), children: [
        Text('${_transport('${s['transport']}')} · ${stateLabel('${s['state']}')}${s['protocol'] == null ? '' : ' · 协议 ${s['protocol']}'}', style: t.bodyLarge),
        if ('${s['error'] ?? ''}'.isNotEmpty && s['state'] != 'online') Padding(padding: const EdgeInsets.only(top: 6), child: Text('${s['error']}', style: TextStyle(color: cs.error))),
        const SizedBox(height: 6),
        SelectableText(s['transport'] == 'stdio' ? '${s['command']} ${((s['args'] as List?) ?? []).join(' ')}${s['sandbox'] == false ? '\n（不在沙箱里）' : ''}' : '${s['url']}', style: t.bodySmall?.copyWith(fontFamily: 'monospace')),
        if (s['plugin'] != null) Text('来自插件 ${s['plugin']}', style: t.bodySmall),
        if ((s['secrets'] as List?)?.isNotEmpty == true) Padding(padding: const EdgeInsets.only(top: 6), child: Text('这台设备上还缺凭据（${(s['secrets'] as List).join('、')}）：在这台设备上重新安装或添加时填写', style: TextStyle(color: cs.error))),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: s['sync'] == true, title: Text(s['sync'] == true ? '多端同步' : '仅本机'),
          subtitle: Text(s['transport'] == 'stdio' ? '本机命令的路径属于这台设备；同步过去后，其他设备上也要有同样的命令' : '配置同步到她的其他身体；登录与凭据不同步，每台设备各自登录'),
          onChanged: (v) async { await act(context, () => api.call('mcp.update', {'id': widget.id, 'sync': v})); _load(); }),
        if (s['oauth'] == true) ...[
          label('登录'),
          Text(s['loggedIn'] == true ? '已登录（令牌只存在这台设备上）' : s['loginPending'] == true ? '等你在浏览器里完成授权' : '还没登录', style: t.bodyMedium),
          Wrap(spacing: 8, children: [
            FilledButton.tonal(onPressed: _login, child: Text(s['loggedIn'] == true ? '重新登录' : '登录')),
            if (s['loggedIn'] == true) TextButton(onPressed: () async { await act(context, () => api.call('mcp.logout', {'id': widget.id}), ok: '已退出登录'); _load(); }, child: const Text('退出登录')),
          ]),
          if (s['loginPending'] == true) ...[
            Padding(padding: const EdgeInsets.only(top: 8), child: Text('浏览器最后停在一个 127.0.0.1 开头、打不开的地址（控制台不在运行基座那台设备上时会这样）？把它的完整地址粘贴到这里：', style: t.bodySmall)),
            Row(children: [
              Expanded(child: TextField(controller: pasted, decoration: const InputDecoration(hintText: 'http://127.0.0.1:…/mcp/oauth/callback?code=…', isDense: true))),
              TextButton(onPressed: () async { final ok = await act(context, () => api.call('mcp.loginFinish', {'url': pasted.text.trim()}), ok: '已登录'); if (ok != null) pasted.clear(); _load(); }, child: const Text('完成登录')),
            ]),
          ],
        ],
        label('工具（${(c['tools'] as List?)?.length ?? 0}）'),
        for (final x in ((c['tools'] as List?) ?? []).cast<Map>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${x['name']}'), subtitle: Text('${x['description']}', maxLines: 3, overflow: TextOverflow.ellipsis)),
        if (((c['resources'] as List?) ?? []).isNotEmpty || ((c['templates'] as List?) ?? []).isNotEmpty) label('资源'),
        for (final x in ((c['resources'] as List?) ?? []).cast<Map>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${x['name'] == '' ? x['uri'] : x['name']}'), subtitle: Text('${x['uri']}${'${x['description'] ?? ''}'.isEmpty ? '' : '\n${x['description']}'}')),
        for (final x in ((c['templates'] as List?) ?? []).cast<Map>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${x['name'] == '' ? x['uriTemplate'] : x['name']}'), subtitle: Text('${x['uriTemplate']}')),
        if (((c['prompts'] as List?) ?? []).isNotEmpty) label('提示词'),
        for (final x in ((c['prompts'] as List?) ?? []).cast<Map>()) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${x['name']}'), subtitle: Text('${x['description']}')),
        if (s['state'] != 'online' && s['enabled'] == true) Padding(padding: const EdgeInsets.only(top: 8), child: Text('连上之后才看得到它提供了什么。', style: t.bodySmall)),
      ]),
    );
  }
}
