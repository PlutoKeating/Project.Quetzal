// 安装向导：把 App 内置的运行基座装进这台手机的 Termux，之后的升级、修复也从这里进。
//   唯一需要用户亲手做的一步：在 Termux 里粘贴一行命令开启外部调用（Termux 的安全设计，无法代劳）。
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import '../api.dart';
import '../igniter.dart';
import '../installer.dart';
import '../widgets.dart';

const enableCommand = 'mkdir -p ~/.termux && echo allow-external-apps=true >> ~/.termux/termux.properties && termux-reload-settings';

class SetupPage extends StatefulWidget {
  final bool upgrade; // 已有运行基座，只是升级或修复
  const SetupPage({super.key, this.upgrade = false});
  @override
  State<SetupPage> createState() => _SetupPageState();
}

class _SetupPageState extends State<SetupPage> {
  final installer = Installer();
  String? bundled, vTermux, vApi, vBoot;
  bool? external, permitted;
  bool busy = false;

  @override
  void initState() { super.initState(); installer.addListener(_onInstaller); _check(); }
  @override
  void dispose() { installer.removeListener(_onInstaller); installer.dispose(); super.dispose(); }

  Future<void> _onInstaller() async {
    final p = installer.last;
    if (p != null && p.done && p.token != null) {
      // 安装脚本把网关令牌直接交给了控制台：同一台手机，不需要配对码
      await api.saveSettings(base: 'http://127.0.0.1:${p.port ?? 7788}', token: p.token);
    }
    if (mounted) setState(() {});
  }

  Future<void> _check() async {
    bundled = await Installer.bundledVersion();
    vTermux = await Igniter.version(Igniter.termux);
    vApi = await Igniter.version(Igniter.termuxApi);
    vBoot = await Igniter.version(Igniter.termuxBoot);
    permitted = vTermux == null ? false : await Igniter.hasPermission();
    external = (vTermux != null && permitted == true) ? await installer.probe() : null;
    if (mounted) setState(() {});
  }

  Future<void> _permit() async {
    setState(() => busy = true);
    await Igniter.requestPermission();
    for (var i = 0; i < 30 && !(await Igniter.hasPermission()); i++) { await Future.delayed(const Duration(seconds: 1)); }
    setState(() => busy = false);
    await _check();
  }

  Future<void> _install() async {
    final cn = Platform.localeName.toLowerCase().contains('zh_cn') || Platform.localeName.toLowerCase().contains('zh-cn');
    await installer.install(cnMirror: cn);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final appsOk = vTermux != null;
    final step1 = appsOk, step2 = step1 && permitted == true, step3 = step2 && external == true;
    return Scaffold(
      appBar: AppBar(title: Text(widget.upgrade ? '升级 Windler' : '在这台手机上安装 Windler')),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Padding(padding: const EdgeInsets.fromLTRB(4, 4, 4, 12), child: Text(
          widget.upgrade
              ? 'App 内置的运行基座是 ${bundled ?? '（此构建没有内置）'}，安装后她会以新版本重新醒来，记忆与配置都保留。'
              : 'Windler 把一台安卓手机变成 agent 的身体。运行基座装在 Termux 里，安装过程大约需要几分钟和几十 MB 下载。',
          style: t.bodyMedium)),
        _Step(n: 1, title: '安装 Termux 三件套', done: appsOk && vApi != null && vBoot != null, children: [
          _AppRow('Termux', vTermux, '运行环境', 'https://f-droid.org/packages/com.termux/'),
          _AppRow('Termux:API', vApi, '相机、麦克风、传感器、通知（没有它她感知不到身体）', 'https://f-droid.org/packages/com.termux.api/'),
          _AppRow('Termux:Boot', vBoot, '开机自动启动（没有它重启后要手动点火）', 'https://f-droid.org/packages/com.termux.boot/'),
          const SizedBox(height: 6),
          Text('三个都要从同一来源安装（推荐 F-Droid，或 GitHub 发布页），Google Play 上的版本已废弃。', style: t.bodySmall),
          Row(children: [TextButton(onPressed: _check, child: const Text('重新检测'))]),
        ]),
        _Step(n: 2, title: '允许 Windler 向 Termux 发指令', done: step2, enabled: step1, children: [
          Text(permitted == true ? '已授权。' : '系统会弹出「在 Termux 中运行命令」的权限请求，请允许。', style: t.bodyMedium),
          if (permitted != true) Row(children: [FilledButton.tonal(onPressed: busy || !step1 ? null : _permit, child: const Text('授权'))]),
        ]),
        _Step(n: 3, title: '在 Termux 里开启外部调用（唯一需要你动手的一步）', done: step3, enabled: step2, children: [
          Text('Termux 默认不接受其他应用的指令。请打开 Termux，长按终端 → 粘贴 → 回车，执行这一行：', style: t.bodyMedium),
          const SizedBox(height: 6),
          SelectableText(enableCommand, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
          const SizedBox(height: 6),
          Wrap(spacing: 8, children: [
            FilledButton.tonal(onPressed: !step2 ? null : () async {
              await Clipboard.setData(const ClipboardData(text: enableCommand));
              if (context.mounted) toast(context, '已复制，正在打开 Termux：长按 → 粘贴 → 回车');
              await Future.delayed(const Duration(milliseconds: 600));
              await Igniter.openTermux();
            }, child: const Text('复制并打开 Termux')),
            OutlinedButton(onPressed: !step2 ? null : () async { setState(() => external = null); await _check(); if (external != true && context.mounted) toast(context, 'Termux 还没有回应：请确认那一行已执行（第一次打开 Termux 需要等它初始化完成）'); }, child: const Text('我已执行，检测')),
          ]),
          if (external == true) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Termux 已回应。', style: t.bodyMedium)),
        ]),
        _Step(n: 4, title: widget.upgrade ? '升级运行基座' : '安装运行基座', done: installer.done, enabled: step3 && bundled != null, children: [
          if (bundled == null) Text('此构建没有内置运行基座（开发版）。构建 APK 前运行 tool/bundle-runtime.sh。', style: t.bodyMedium),
          if (bundled != null && !installer.running && !installer.done)
            Row(children: [FilledButton.icon(onPressed: !step3 ? null : _install, icon: const Icon(Icons.download), label: Text(widget.upgrade ? '升级到 $bundled' : '安装 $bundled'))]),
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
            if (installer.last?.log != null) Container(
              margin: const EdgeInsets.only(top: 6), padding: const EdgeInsets.all(8), color: Colors.black26,
              child: SelectableText(installer.last!.log!, style: const TextStyle(fontFamily: 'monospace', fontSize: 11))),
            Row(children: [TextButton(onPressed: _install, child: const Text('重试'))]),
          ],
          if (installer.done) Text('完成：运行基座 ${installer.last?.version} 已启动，控制台已自动连接。', style: t.bodyMedium),
        ]),
        _Step(n: 5, title: '让她不被系统杀掉', done: false, enabled: true, children: [
          Text('安卓会清理后台应用。请把 Termux、Termux:Boot、Termux:API 和 Windler 加入电池优化的忽略名单，并在厂商的「自启动 / 后台运行」管理里放行。有锁屏密码的手机，重启后要解锁一次她才会醒来。', style: t.bodyMedium),
          const SizedBox(height: 6),
          Wrap(spacing: 8, children: [
            OutlinedButton(onPressed: () => Igniter.requestIgnoreBattery().catchError((_) {}), child: const Text('忽略 Windler 的电池优化')),
            OutlinedButton(onPressed: () => Igniter.openBatterySettings().catchError((_) {}), child: const Text('电池优化名单')),
            OutlinedButton(onPressed: () => Igniter.openAutostart().catchError((_) {}), child: const Text('自启动管理')),
            if (vBoot != null) OutlinedButton(onPressed: () => Igniter.openApp(Igniter.termuxBoot).catchError((_) {}), child: const Text('打开一次 Termux:Boot')),
          ]),
        ]),
        if (installer.done) Padding(padding: const EdgeInsets.all(12), child: FilledButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst), child: const Text('开始'))),
      ]),
    );
  }
}

class _Step extends StatelessWidget {
  final int n; final String title; final bool done, enabled; final List<Widget> children;
  const _Step({required this.n, required this.title, required this.done, this.enabled = true, required this.children});
  @override
  Widget build(BuildContext context) => Opacity(opacity: enabled ? 1 : 0.5, child: Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(done ? Icons.check_circle : Icons.circle_outlined, color: done ? Colors.green : null, size: 20),
            const SizedBox(width: 8),
            Expanded(child: Text('$n. $title', style: Theme.of(context).textTheme.titleMedium)),
          ]),
          const SizedBox(height: 8),
          ...children,
        ]))));
}

class _AppRow extends StatelessWidget {
  final String name, desc, url; final String? version;
  const _AppRow(this.name, this.version, this.desc, this.url);
  @override
  Widget build(BuildContext context) => ListTile(dense: true, contentPadding: EdgeInsets.zero,
        leading: Icon(version != null ? Icons.check_circle : Icons.download_for_offline_outlined, color: version != null ? Colors.green : null, size: 20),
        title: Text(version != null ? '$name $version' : name), subtitle: Text(desc),
        trailing: version == null ? TextButton(onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication), child: const Text('下载')) : null);
}
