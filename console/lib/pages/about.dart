// 关于：简介、版本（控制台 / 运行基座 / 最新发布）、检查更新、升级。三种形态共用同一页：
//   安卓 App：App 自身的更新走 updater.dart（AppUpdateSection：下载 APK、核对、交给系统安装器），运行基座的升级走安装向导（新 App 内置的版本）；
//   Linux 桌面版与网页版：让运行基座在它所在的机器上后台重跑一键安装脚本（网关方法 selfUpdate，Linux 适配器实现），运行基座、网页控制台与原生控制台一起更新，
//     服务重启一次后版本号会变；桌面版装完还要重新打开控制台才用上新版的界面。
import 'dart:convert';
import 'dart:io' show Directory, Platform, Process, ProcessStartMode, exit;
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import '../api.dart';
import '../installer.dart';
import '../platform/caps.dart';
import '../platform/net.dart' as net;
import '../updater.dart' show AppRelease, compareVersions, latestReleaseApi, siteLatestApi, githubRepo;
import '../widgets.dart';
import 'control.dart' show AppUpdateSection;
import 'setup.dart';

const _site = 'https://quetzal.plutokeating.beer';

class AboutPage extends StatefulWidget {
  const AboutPage({super.key});
  @override
  State<AboutPage> createState() => _AboutPageState();
}

class _AboutPageState extends State<AboutPage> {
  String? appVersion; // 这个控制台（App / 桌面版 / 网页版）的版本
  String? bundled; // 安卓 App 内置的运行基座版本
  AppRelease? latest; // GitHub 最新正式版
  bool checking = false, upgrading = false;
  String? checkError, upgradeFrom, upgradeMessage;

  @override
  void initState() {
    super.initState();
    PackageInfo.fromPlatform().then((p) { if (mounted) setState(() => appVersion = p.version); }).catchError((_) {});
    if (hasBody) Installer.bundledVersion().then((v) { if (mounted) setState(() => bundled = v); });
    api.addListener(_onApi);
    _check();
  }
  @override
  void dispose() { api.removeListener(_onApi); super.dispose(); }

  /// 升级进行中：服务重启后重连，版本号变了就算完成。
  void _onApi() {
    if (!upgrading || !mounted) return;
    final v = '${api.status['version'] ?? ''}';
    if (v.isNotEmpty && v != upgradeFrom) setState(() { upgrading = false; upgradeMessage = '运行基座已升级到 $v。'; });
  }

  /// 问 GitHub 最新的正式版（所有形态都能问：安卓与桌面版用 dart:io，网页版用浏览器请求，GitHub 的接口允许跨域）。
  Future<void> _check() async {
    setState(() { checking = true; checkError = null; });
    try {
      // 官网镜像源优先，退回 GitHub
      net.HttpReply r;
      try { r = await net.request('GET', siteLatestApi, timeout: const Duration(seconds: 15)); if (r.status >= 400) throw '镜像源 ${r.status}'; }
      catch (_) { r = await net.request('GET', latestReleaseApi, timeout: const Duration(seconds: 15)); }
      if (r.status >= 400) throw '读取发布信息失败（${r.status}）${r.status == 403 ? '，稍后再试' : ''}';
      final rel = AppRelease.fromJson(jsonDecode(r.body) as Map);
      if (mounted) setState(() => latest = rel);
    } catch (e) { if (mounted) setState(() => checkError = '$e'); }
    if (mounted) setState(() => checking = false);
  }

  /// Linux 桌面版 / 网页版：让运行基座在它那台机器上后台重跑安装脚本。
  Future<void> _selfUpdate() async {
    final to = latest?.version ?? '最新版';
    if (!await confirm(context, '升级到 $to', '运行基座会在它所在的机器上下载最新版本并重启一次（约一分钟），这期间控制台会短暂断开。ta 的记忆与配置不受影响。')) return;
    if (!mounted) return;
    final r = await act(context, () => api.call<Map>('selfUpdate'));
    if (r == null || !mounted) return;
    setState(() { upgrading = true; upgradeFrom = '${api.status['version'] ?? ''}'; upgradeMessage = '${r['message'] ?? '已开始升级'}'; });
  }

  /// Linux 桌面版：升级后重新打开控制台（新版本的可执行文件在 console/current 下）。
  void _relaunch() {
    final self = Platform.resolvedExecutable; // …/console/<版本>/quetzal-console
    final next = '${Directory(self).parent.parent.path}/current/quetzal-console';
    try { Process.start(next, [], mode: ProcessStartMode.detached); exit(0); } catch (e) { toast(context, '没能重新打开：$e'); }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final rt = '${api.status['version'] ?? ''}';
    final form = hasBody ? '安卓 App' : isDesktop ? 'Linux 桌面版' : '网页版';
    final rtOutdated = latest != null && rt.isNotEmpty && compareVersions(latest!.version, rt) > 0;
    final appOutdated = latest != null && appVersion != null && compareVersions(latest!.version, appVersion!) > 0;
    final bundledNewer = bundled != null && rt.isNotEmpty && compareVersions(bundled!, rt) > 0;
    Widget link(String label, String url) => TextButton(onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication), child: Text(label));
    return PageFrame(
      title: '关于',
      body: ListenableBuilder(listenable: api, builder: (context, _) => ListView(padding: const EdgeInsets.all(12), children: [
        Section('Quetzal', [
          Row(children: [const Orb(mode: 'awake', alertness: 1, size: 44), const SizedBox(width: 14), Expanded(child: Text('开源的 agent 运行基座。\n让一个 AI agent 住进一部旧手机，像生命一样活着。', style: t.bodyLarge))]),
          const SizedBox(height: 8),
          Text('ta 什么时候醒来由内驱力与昼夜节律决定；身体是这部手机或这台电脑；人格、记忆、日记在你自己的私有 git 仓库里，换身体整个带走。相机、麦克风、定位默认每次询问，审批、预算、急停、审计齐全。', style: t.bodyMedium?.copyWith(color: cs.onSurfaceVariant)),
          Wrap(children: [link('官网', _site), link('文档', '$_site/zh/docs'), link('GitHub', 'https://github.com/$githubRepo'), link('AGPL-3.0', 'https://github.com/$githubRepo/blob/main/LICENSE')]),
        ]),
        Section('版本', [
          Text('控制台（$form）：${appVersion ?? '…'}'),
          Text('运行基座：${rt.isEmpty ? '（未连接）' : rt}${api.status['body'] != null ? ' · 身体 ${api.status['body']}（${api.status['adapter']}）' : ''}'),
          if (hasBody) Text('App 内置的运行基座：${bundled ?? '（无）'}'),
          Text('最新发布：${checking ? '正在检查…' : latest?.version ?? (checkError != null ? '检查失败' : '—')}'),
          if (checkError != null) Text(checkError!, style: TextStyle(color: cs.error, fontSize: 12)),
          const SizedBox(height: 6),
          Wrap(spacing: 8, children: [
            OutlinedButton.icon(onPressed: checking ? null : _check, icon: const Icon(Icons.refresh, size: 18), label: const Text('检查更新')),
            if (latest != null) TextButton(onPressed: () => launchUrl(Uri.parse(latest!.url), mode: LaunchMode.externalApplication), child: const Text('发布说明')),
          ]),
        ]),
        if (hasBody) ...[
          const AppUpdateSection(),
          if (bundledNewer) Section('运行基座', [
            Text('App 内置的运行基座 $bundled 比正在运行的 $rt 新。'),
            FilledButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage(upgrade: true))), child: const Text('升级运行基座')),
          ]),
        ] else Section('升级', [
          if (upgrading) ...[
            Row(children: [const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)), const SizedBox(width: 10), Expanded(child: Text('正在升级：$upgradeMessage'))]),
          ] else if (upgradeMessage != null) ...[
            Text(upgradeMessage!, style: TextStyle(color: cs.primary)),
            if (isDesktop) ...[
              const SizedBox(height: 4),
              const Text('这个桌面版控制台也已更新到磁盘上，重新打开后生效。', style: TextStyle(fontSize: 12)),
              FilledButton.tonal(onPressed: _relaunch, child: const Text('重新打开控制台')),
            ],
          ] else if (latest == null) const Text('先检查更新。')
          else if (!rtOutdated && !appOutdated) Text('已是最新（${latest!.version}）。', style: TextStyle(color: cs.primary))
          else ...[
            Text('${rtOutdated ? '运行基座 $rt' : ''}${rtOutdated && appOutdated ? '、' : ''}${appOutdated ? '控制台 $appVersion' : ''} 可以升级到 ${latest!.version}。'),
            const SizedBox(height: 4),
            Text(isDesktop
                ? '点下面的按钮，运行基座会在这台机器上后台重跑安装脚本：运行基座、网页控制台与这个桌面版控制台一起更新，服务重启一次。'
                : '点下面的按钮，运行基座会在它所在的机器上后台重跑安装脚本并重启一次；网页版本身由运行基座托管，刷新页面即是新版。', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
            const SizedBox(height: 8),
            FilledButton.icon(onPressed: api.conn == Conn.online ? _selfUpdate : null, icon: const Icon(Icons.system_update_alt, size: 18), label: Text('升级到 ${latest!.version}')),
          ],
          const SizedBox(height: 6),
          const Text('手动方式：在装运行基座的机器上再跑一次  curl -fsSL https://quetzal.plutokeating.beer/install | bash', style: TextStyle(fontSize: 12)),
        ]),
      ])),
    );
  }
}
