// 关于：简介，与一张「版本」卡片（当前版本 + 一个动作：已是最新 / 升级 / 进度）。三种形态共用同一页：
//   安卓 App：App 自身的更新走 updater.dart（下载 APK、核对、交给系统安装器），运行基座的升级走安装向导（新 App 内置的版本）；
//   Linux 桌面版与网页版：让运行基座在它所在的机器上后台重跑一键安装脚本（网关方法 selfUpdate，Linux 适配器实现），运行基座、网页控制台与原生控制台一起更新，
//     服务重启一次后版本号会变；桌面版装完还要重新打开控制台才用上新版的界面。
import 'dart:async';
import 'dart:convert';
import 'dart:io' show Directory, Platform, Process, ProcessStartMode, exit;
import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../api.dart';
import '../installer.dart';
import '../platform/caps.dart';
import '../platform/net.dart' as net;
import '../updater.dart' show AppRelease, UpdateState, appUpdater, compareVersions, directLatest, downloadPage, siteLatestApi, githubRepo;
import '../widgets.dart';
import 'setup.dart';
import '../links.dart';

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
  String? checkError, upgradeFrom, upgradeMessage, upgradeError, upgradeId, upgradeStep;
  Timer? _poll;
  int? _doneAt; // 升级脚本成功结束的时刻：之后一段时间版本号还没变，就说明没升上去

  @override
  void initState() {
    super.initState();
    PackageInfo.fromPlatform().then((p) { if (mounted) setState(() => appVersion = p.version); }).catchError((_) {});
    api.addListener(_onApi);
    if (hasBody) {
      Installer.bundledVersion().then((v) { if (mounted) setState(() => bundled = v); });
      if (appUpdater.state == UpdateState.idle) appUpdater.check();
    } else {
      _check();
      _resume();
    }
  }
  @override
  void dispose() { api.removeListener(_onApi); _poll?.cancel(); super.dispose(); }

  /// 升级进行中：服务重启后重连，版本号变了就算完成。
  void _onApi() {
    if (!upgrading || !mounted) return;
    final v = '${api.status['version'] ?? ''}';
    if (v.isNotEmpty && v != upgradeFrom) _finish(message: v);
  }

  void _finish({String? message, String? error}) {
    _poll?.cancel(); _poll = null; _doneAt = null;
    if (mounted) setState(() { upgrading = false; upgradeMessage = message; upgradeError = error; });
  }

  /// 打开这页时升级还在进行（例如控制台重开过）：接着显示进度。
  Future<void> _resume() async {
    try {
      final st = await api.call<Map>('selfUpdateStatus');
      if (st['running'] == true && mounted) {
        setState(() { upgrading = true; upgradeFrom = '${api.status['version'] ?? ''}'; upgradeId = '${st['id'] ?? ''}'; upgradeStep = st['step'] as String?; });
        _startPoll();
      }
    } catch (_) {}
  }

  /// 升级进行中每 3 秒问一次升级的状态：失败、卡住就停下来说原因；成功结束后等版本号变化（服务重启期间问不到，照常等）。
  void _startPoll() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) async {
      if (!upgrading || !mounted) { _poll?.cancel(); return; }
      Map st;
      try { st = await api.call<Map>('selfUpdateStatus'); } catch (_) { return; }
      if (!mounted || !upgrading) return;
      if (upgradeId != null && upgradeId!.isNotEmpty && '${st['id'] ?? ''}' != upgradeId) return;
      setState(() => upgradeStep = st['step'] as String?);
      final step = '${st['step'] ?? ''}';
      if (st['stalled'] == true) return _finish(error: '升级卡住了${step.isEmpty ? '' : '：$step'}');
      final code = st['exitCode'];
      if (code is num && code != 0) return _finish(error: '升级没成功${step.isEmpty ? '（退出码 $code）' : '：$step'}');
      if (code == 0) {
        _doneAt ??= DateTime.now().millisecondsSinceEpoch;
        final v = '${api.status['version'] ?? ''}';
        if (v.isNotEmpty && v != upgradeFrom) return _finish(message: v);
        if (DateTime.now().millisecondsSinceEpoch - _doneAt! > 60000) return _finish(error: '升级跑完了，但运行基座还是 $v${step.isEmpty ? '' : '：$step'}');
      }
    });
  }

  /// 问 GitHub 最新的正式版（所有形态都能问：安卓与桌面版用 dart:io，网页版用浏览器请求，GitHub 的接口允许跨域）。
  Future<void> _check() async {
    setState(() { checking = true; checkError = null; });
    try {
      // 官网镜像源优先，退回 GitHub
      Map j;
      try {
        final r = await net.request('GET', siteLatestApi, timeout: const Duration(seconds: 15)); if (r.status >= 400) throw '镜像源 ${r.status}';
        j = jsonDecode(r.body) as Map;
      } catch (_) {
        // 直连 GitHub：发布列表按 npm 上运行基座的版本封顶（两者取较老的）
        j = await directLatest((u) async {
          final x = await net.request('GET', u, timeout: const Duration(seconds: 15));
          if (x.status >= 400) throw '读取发布信息失败（${x.status}）${x.status == 403 ? '，稍后再试' : ''}';
          return jsonDecode(x.body);
        });
      }
      final rel = AppRelease.fromJson(j);
      if (mounted) setState(() => latest = rel);
    } catch (e) { if (mounted) setState(() => checkError = '$e'); }
    if (mounted) setState(() => checking = false);
  }

  /// Linux 桌面版 / 网页版：让运行基座在它那台机器上后台重跑安装脚本。
  Future<void> _selfUpdate() async {
    final to = latest?.version ?? '最新版';
    if (!await confirm(context, '更新到 $to', '约一分钟，期间会短暂断开。')) return;
    if (!mounted) return;
    final r = await act(context, () => api.call<Map>('selfUpdate', {if (latest != null) 'version': latest!.version}));
    if (r == null || !mounted) return;
    final st = r['status'];
    setState(() { upgrading = true; upgradeFrom = '${api.status['version'] ?? ''}'; upgradeMessage = null; upgradeError = null; upgradeId = st is Map ? '${st['id'] ?? ''}' : null; upgradeStep = null; });
    _startPoll();
  }

  /// Linux 桌面版：升级后重新打开控制台（新版本的可执行文件在 console/current 下；旧版本目录此时已被安装脚本删掉）。
  /// 必须等新进程真正启动后再退出：Process.start 是异步的，不等就 exit，新进程根本来不及起来。
  Future<void> _relaunch() async {
    final self = Platform.resolvedExecutable; // …/console/<版本>/quetzal-console（目录已删时末尾带「 (deleted)」，取上两级不受影响）
    final next = '${Directory(self).parent.parent.path}/current/quetzal-console';
    try {
      await Process.start(next, ['--replace'], mode: ProcessStartMode.detached); // --replace：新版本接管单实例的名字，这个旧的随即退出（见 linux/runner）
      exit(0);
    } catch (e) { if (mounted) toast(context, '没能重新打开：$e'); }
  }

  /// 版本卡片：当前版本一行，下面只放此刻需要的那一个状态或动作。
  Widget _version(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final muted = TextStyle(color: cs.onSurfaceVariant);
    final rt = '${api.status['version'] ?? ''}';
    final mine = hasBody ? (appUpdater.current ?? appVersion) : appVersion;
    // 控制台与运行基座同版本时只写一个号；不同时两个都写
    final line = mine == null || rt.isEmpty || mine == rt ? 'Quetzal ${mine ?? (rt.isEmpty ? '…' : rt)}' : '控制台 $mine · 运行基座 $rt';
    Widget notes(AppRelease r) => TextButton(onPressed: () => openExternal(context, r.url), child: const Text('新功能'));
    Widget row(List<Widget> c) => Padding(padding: const EdgeInsets.only(top: 8), child: Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: c));
    Widget spin(String text) => row([const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)), Text(text, style: muted)]);
    final List<Widget> body;
    if (hasBody) {
      final u = appUpdater, r = u.latest;
      final bundledNewer = bundled != null && rt.isNotEmpty && compareVersions(bundled!, rt) > 0;
      body = [
        if (bundledNewer) row([FilledButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage(upgrade: true))), child: Text('更新到 $bundled'))]),
        switch (u.state) {
          UpdateState.checking => spin('正在检查…'),
          UpdateState.available when r != null => row([FilledButton(onPressed: u.downloadAndInstall, child: Text('更新到 ${r.version}')), notes(r)]),
          UpdateState.downloading => Padding(padding: const EdgeInsets.only(top: 10), child: LinearProgressIndicator(value: u.progress < 0 ? null : u.progress)),
          UpdateState.verifying => spin('正在核对…'),
          UpdateState.needPermission => row([Text('需要允许安装应用', style: muted), FilledButton(onPressed: u.install, child: const Text('安装'))]),
          UpdateState.handedOff => row([Text('装好后重新打开 Quetzal', style: muted), TextButton(onPressed: u.install, child: const Text('重新安装'))]),
          UpdateState.failed => row([Text(u.error ?? '更新失败', style: TextStyle(color: cs.error)), if (u.hasUpdate) TextButton(onPressed: u.downloadAndInstall, child: const Text('重试')), TextButton(onPressed: () => openExternal(context, downloadPage), child: const Text('去下载页'))]),
          UpdateState.upToDate => row([Text('已是最新', style: muted), TextButton(onPressed: u.check, child: const Text('检查更新'))]),
          _ => row([TextButton(onPressed: u.check, child: const Text('检查更新'))]),
        },
      ];
    } else {
      final l = latest;
      final outdated = l != null && ((rt.isNotEmpty && compareVersions(l.version, rt) > 0) || (appVersion != null && compareVersions(l.version, appVersion!) > 0));
      body = [
        if (upgrading) spin(upgradeStep == null || upgradeStep!.isEmpty ? '正在更新…' : '正在更新：$upgradeStep')
        else if (upgradeError != null) row([Text(upgradeError!, style: TextStyle(color: cs.error)), if (l != null) TextButton(onPressed: api.conn == Conn.online ? _selfUpdate : null, child: const Text('重试'))])
        else if (upgradeMessage != null) row([
          Text(isDesktop ? '已更新到 $upgradeMessage' : '已更新到 $upgradeMessage，刷新页面即可', style: TextStyle(color: cs.primary)),
          if (isDesktop) FilledButton(onPressed: _relaunch, child: const Text('重新打开')),
        ])
        else if (checking) spin('正在检查…')
        else if (checkError != null) row([Text('检查失败', style: TextStyle(color: cs.error)), TextButton(onPressed: _check, child: const Text('重试'))])
        else if (outdated) row([FilledButton(onPressed: api.conn == Conn.online ? _selfUpdate : null, child: Text('更新到 ${l.version}')), notes(l)])
        else row([Text('已是最新', style: muted), TextButton(onPressed: _check, child: const Text('检查更新'))]),
      ];
    }
    return Section('版本', [Text(line, style: Theme.of(context).textTheme.titleSmall), ...body]);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    Widget link(String label, String url) => TextButton(onPressed: () => openExternal(context, url), child: Text(label));
    return PageFrame(
      title: '关于',
      body: ListenableBuilder(listenable: Listenable.merge([api, appUpdater]), builder: (context, _) => ListView(padding: const EdgeInsets.all(12), children: [
        Section('Quetzal', [
          Row(children: [const Orb(mode: 'awake', alertness: 1, size: 44), const SizedBox(width: 14), Expanded(child: Text('Not running, but living.', style: t.bodyLarge?.copyWith(color: cs.onSurfaceVariant)))]),
          Wrap(children: [link('官网', _site), link('文档', '$_site/zh/docs'), link('GitHub', 'https://github.com/$githubRepo'), link('AGPL-3.0', 'https://github.com/$githubRepo/blob/main/LICENSE')]),
        ]),
        _version(context),
      ])),
    );
  }
}
