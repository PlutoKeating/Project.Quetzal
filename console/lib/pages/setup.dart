// 安装向导：启动 App 内置的运行基座（只装一个 App，不需要 Termux），之后的升级、修复也从这里进。
//   一次只做一件事，能自动的都自动：打开就开始安装 → 装好自动弹出权限请求 → 后台运行 → 登录（新用户自动建 agent，老用户接回已有的）→ 接上模型。
//   每一步完成就收起成一行；登录与模型可以跳过，随时点「开始」进去。升级 / 重装（upgrade）只有第一步，完成后自动返回。
import 'package:flutter/material.dart';
import '../api.dart';
import '../igniter.dart';
import '../installer.dart';
import '../widgets.dart';
import 'mesh.dart';
import 'providers.dart';

class SetupPage extends StatefulWidget {
  final bool upgrade; // 已有运行基座，只是升级或修复
  const SetupPage({super.key, this.upgrade = false});
  @override
  State<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends State<SetupPage> with WidgetsBindingObserver {
  final installer = Installer();
  String? bundled;
  bool? available;
  bool battery = false, asked = false, skipBattery = false, skipLogin = false;
  Map<String, bool> perms = {};

  @override
  void initState() {
    super.initState();
    installer.addListener(_onInstaller);
    api.addListener(_onApi);
    WidgetsBinding.instance.addObserver(this);
    _check(start: true);
  }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); api.removeListener(_onApi); installer.removeListener(_onInstaller); installer.dispose(); super.dispose(); }
  // 系统的权限弹窗、电池优化页关掉回来时重新检查
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) { if (s == AppLifecycleState.resumed) _check(); }
  void _onApi() { if (mounted) setState(() {}); }

  Future<void> _onInstaller() async {
    if (installer.done && installer.token != null) {
      // 同一台手机、同一个 App：令牌直接从家目录读到，不需要配对码
      await api.saveSettings(base: 'http://127.0.0.1:$runtimePort', token: installer.token);
      if (widget.upgrade) { if (mounted) Navigator.of(context).pop(); return; }
      // 装好就请求身体权限（系统弹窗），不让人再点一次
      if (!asked && perms.values.contains(false)) { asked = true; await Igniter.requestBodyPermissions(); }
    }
    if (mounted) setState(() {});
  }

  Future<void> _check({bool start = false}) async {
    bundled = await Installer.bundledVersion();
    available = await Igniter.available();
    perms = await Igniter.bodyPermissions();
    battery = await Igniter.ignoringBattery();
    if (mounted) setState(() {});
    // 打开就开始，不需要「安装」按钮
    if (start && available == true && !installer.running && !installer.done) installer.install();
  }

  bool get _bound => ((api.status['mesh'] as Map?) ?? {})['bound'] == true;
  bool get _models => ((api.status['models'] as List?) ?? []).isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final muted = t.bodyMedium?.copyWith(color: cs.onSurfaceVariant);
    const names = {'camera': '相机', 'microphone': '麦克风', 'location': '位置', 'notifications': '通知'};
    final installed = installer.done;
    final permitted = perms.isNotEmpty && !perms.values.contains(false);
    final m = (api.status['mesh'] as Map?) ?? {};
    final binding = m['binding'] as Map?;
    // 第一个没完成的步骤是当前步骤，只有它展开
    final done = [installed, permitted, battery || skipBattery, _bound || skipLogin, _models];
    final current = widget.upgrade ? 0 : done.indexOf(false);
    Widget step(int i, String title, List<Widget> children) => _Step(title: title, done: done[i], active: current == i, children: children);
    return Scaffold(
      appBar: AppBar(title: Text(widget.upgrade ? '更新' : '欢迎')),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        step(0, widget.upgrade ? '更新到 ${bundled ?? ''}' : '安装', [
          if (available == false) Text('这个版本没有内置运行环境', style: muted),
          if (installer.running) ...[
            Text(installSteps[installer.reached.isEmpty ? 'start' : installer.reached.last] ?? '', style: muted),
            const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator()),
          ],
          if (installer.error != null) ...[
            Text(installer.error!, style: t.bodyMedium?.copyWith(color: cs.error)),
            Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: installer.install, child: const Text('重试'))),
          ],
        ]),
        if (!widget.upgrade) ...[
          step(1, '权限', [
            Wrap(spacing: 8, runSpacing: 4, children: [
              for (final e in names.entries) Chip(avatar: Icon(perms[e.key] == true ? Icons.check_circle : Icons.circle_outlined, size: 16, color: perms[e.key] == true ? Colors.green : null), label: Text(e.value)),
            ]),
            const SizedBox(height: 4),
            Text('每次使用前仍会问你', style: muted),
            const SizedBox(height: 8),
            Row(children: [FilledButton(onPressed: Igniter.requestBodyPermissions, child: const Text('允许'))]),
          ]),
          step(2, '后台运行', [
            Text('不让系统把${api.name}关掉', style: muted),
            const SizedBox(height: 8),
            Wrap(spacing: 8, children: [
              FilledButton(onPressed: () => Igniter.requestIgnoreBattery().catchError((_) {}), child: const Text('允许')),
              TextButton(onPressed: () => Igniter.openAutostart().catchError((_) {}), child: const Text('自启动设置')),
              TextButton(onPressed: () => setState(() => skipBattery = true), child: const Text('跳过')),
            ]),
          ]),
          step(3, '登录', [
            if (binding == null) ...[
              Text('在你所有的设备上都是同一个${api.name}', style: muted),
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: [
                FilledButton(onPressed: '${m['server'] ?? ''}'.isEmpty ? null : () => signInDevice(context), child: const Text('用 GitHub 登录')),
                TextButton(onPressed: () => setState(() => skipLogin = true), child: const Text('跳过')),
              ]),
            ],
            if (binding != null) DeviceCodeView(pending: binding, onCancel: () => act(context, () => api.call('mesh.cancelBind'))),
            if ('${m['error'] ?? ''}'.isNotEmpty) Text('${m['error']}', style: TextStyle(color: cs.error)),
          ]),
          step(4, '模型', [
            Text('${api.name}用它思考', style: muted),
            const SizedBox(height: 8),
            Row(children: [FilledButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ProvidersPage())), child: const Text('选择模型'))]),
          ]),
          if (installed) Padding(padding: const EdgeInsets.all(12), child: FilledButton(
            onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
            child: const Text('开始'))),
        ],
      ]),
    );
  }
}

class _Step extends StatelessWidget {
  final String title; final bool done, active; final List<Widget> children;
  const _Step({required this.title, required this.done, required this.active, required this.children});
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(done ? Icons.check_circle : Icons.circle_outlined, color: done ? Colors.green : active ? cs.primary : cs.outline, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(color: done || active ? null : cs.onSurfaceVariant))),
          ]),
          if (active && !done) ...[const SizedBox(height: 10), ...children],
        ])));
  }
}
