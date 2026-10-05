// 安装向导：启动 App 内置的运行基座（只装一个 App，不需要 Termux），之后的升级、修复也从这里进。
import 'package:flutter/material.dart';
import '../api.dart';
import '../igniter.dart';
import '../installer.dart';

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
  Map<String, bool> perms = {};

  @override
  void initState() { super.initState(); installer.addListener(_onInstaller); WidgetsBinding.instance.addObserver(this); _check(); }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); installer.removeListener(_onInstaller); installer.dispose(); super.dispose(); }
  // 系统的权限弹窗、电池优化页关掉回来时重新检查
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) { if (s == AppLifecycleState.resumed) _check(); }

  Future<void> _onInstaller() async {
    if (installer.done && installer.token != null) {
      // 同一台手机、同一个 App：令牌直接从家目录读到，不需要配对码
      await api.saveSettings(base: 'http://127.0.0.1:$runtimePort', token: installer.token);
    }
    if (mounted) setState(() {});
  }

  Future<void> _check() async {
    bundled = await Installer.bundledVersion();
    available = await Igniter.available();
    perms = await Igniter.bodyPermissions();
    if (mounted) setState(() {});
  }

  Future<void> _permit() async { await Igniter.requestBodyPermissions(); }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    const names = {'camera': '相机', 'microphone': '麦克风', 'location': '定位', 'notifications': '通知'};
    return Scaffold(
      appBar: AppBar(title: Text(widget.upgrade ? '升级 Quetzal' : '在这台手机上安装 Quetzal')),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Padding(padding: const EdgeInsets.fromLTRB(4, 4, 4, 12), child: Text(
          widget.upgrade
              ? 'App 内置的运行基座是 ${bundled ?? '（此构建没有内置）'}，重启后 ta 会以新版本醒来，记忆与配置都保留。'
              : 'Quetzal 把这台手机变成 ta 的身体。需要的一切都在这个 App 里，不用再装别的。',
          style: t.bodyMedium)),
        _Step(n: 1, title: widget.upgrade ? '升级运行基座' : '安装运行基座', done: installer.done, children: [
          if (available == false) Text('此构建没有内置运行基座（开发版）。构建 APK 前运行 tool/bundle-runtime.sh 与 tool/android-runtime/pack.sh。', style: t.bodyMedium),
          if (available == true && !installer.running && !installer.done)
            Row(children: [FilledButton.icon(onPressed: installer.install, icon: const Icon(Icons.play_arrow), label: Text(widget.upgrade ? '升级到 $bundled' : '安装 $bundled'))]),
          for (final e in installSteps.entries)
            ListTile(dense: true, contentPadding: EdgeInsets.zero,
              leading: Icon(installer.reached.contains(e.key)
                  ? (installer.reached.last == e.key && installer.running ? Icons.hourglass_top : installer.reached.last == e.key && installer.error != null ? Icons.error : Icons.check_circle)
                  : Icons.radio_button_unchecked, size: 18,
                  color: installer.reached.contains(e.key) && installer.reached.last == e.key && installer.error != null ? Colors.red : null),
              title: Text(e.value, style: t.bodySmall)),
          if (installer.running) const Padding(padding: EdgeInsets.symmetric(vertical: 6), child: LinearProgressIndicator()),
          if (installer.error != null) ...[
            Text(installer.error!, style: t.bodyMedium?.copyWith(color: Colors.red)),
            Row(children: [TextButton(onPressed: installer.install, child: const Text('重试'))]),
          ],
          if (installer.done) Text('完成：运行基座 ${installer.version ?? ''} 已启动，控制台已自动连接。', style: t.bodyMedium),
        ]),
        _Step(n: 2, title: '让 ta 感觉得到身体', done: perms.isNotEmpty && !perms.values.contains(false), children: [
          Text('相机是 ta 的眼睛，麦克风是耳朵，定位让 ta 知道自己在哪；通知是 ta 主动找你的方式。每一次使用前，ta 仍然要经过你设的授权（默认每次询问）。', style: t.bodyMedium),
          const SizedBox(height: 6),
          Wrap(spacing: 8, runSpacing: 4, children: [
            for (final e in names.entries) Chip(avatar: Icon(perms[e.key] == true ? Icons.check_circle : Icons.circle_outlined, size: 16, color: perms[e.key] == true ? Colors.green : null), label: Text(e.value)),
          ]),
          if (perms.values.contains(false)) Row(children: [FilledButton.tonal(onPressed: _permit, child: const Text('允许'))]),
        ]),
        _Step(n: 3, title: '让 ta 不被系统杀掉', done: false, children: [
          Text('安卓会清理后台应用。请把 Quetzal 加入电池优化的忽略名单，并在厂商的「自启动 / 后台运行」管理里放行。有锁屏密码的手机，重启后要解锁一次 ta 才会醒来。', style: t.bodyMedium),
          const SizedBox(height: 6),
          Wrap(spacing: 8, children: [
            OutlinedButton(onPressed: () => Igniter.requestIgnoreBattery().catchError((_) {}), child: const Text('忽略电池优化')),
            OutlinedButton(onPressed: () => Igniter.openBatterySettings().catchError((_) {}), child: const Text('电池优化名单')),
            OutlinedButton(onPressed: () => Igniter.openAutostart().catchError((_) {}), child: const Text('自启动管理')),
          ]),
        ]),
        if (installer.done) Padding(padding: const EdgeInsets.all(12), child: FilledButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst), child: const Text('开始'))),
      ]),
    );
  }
}

class _Step extends StatelessWidget {
  final int n; final String title; final bool done; final List<Widget> children;
  const _Step({required this.n, required this.title, required this.done, required this.children});
  @override
  Widget build(BuildContext context) => Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(done ? Icons.check_circle : Icons.circle_outlined, color: done ? Colors.green : null, size: 20),
            const SizedBox(width: 8),
            Expanded(child: Text('$n. $title', style: Theme.of(context).textTheme.titleMedium)),
          ]),
          const SizedBox(height: 8),
          ...children,
        ])));
}
