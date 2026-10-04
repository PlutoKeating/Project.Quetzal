// App 自身的更新（只在安卓 App 里有意义）：问 GitHub Release 最新的正式版，下载同架构的 APK，核对 SHA256SUMS，交给系统安装器。
//   装好新 App 之后，运行基座的升级由现有的流程接管：新 App 内置的版本与运行中的不同 → 外壳顶部的「升级」横幅 → 安装向导第 4 步。
//   这里只做 App 这一层；网页版与 Linux 桌面版的升级在装运行基座的那台机器上再跑一次安装命令。
//   原生侧（MethodChannel quetzal/updater，MainActivity.kt）：自己的版本号、缓存目录、是否允许安装未知应用、打开对应设置页、用 FileProvider 把 APK 交给系统安装器。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'platform/caps.dart';

const githubRepo = 'PlutoKeating/Project.Quetzal';
const latestReleaseApi = 'https://api.github.com/repos/$githubRepo/releases/latest';
/// 官网的镜像源（website/worker/index.ts）：GitHub 在不少网络里连不上，先问它；它返回的资产地址已指向官网的 /dl/ 镜像，原地址在 github_download_url。
const siteOrigin = 'https://quetzal.plutokeating.beer';
const siteLatestApi = '$siteOrigin/api/releases/latest';
const downloadPage = 'https://quetzal.plutokeating.beer/download';
const apkArch = 'arm64'; // 发版工作流只出 quetzal-<版本>-android-arm64.apk（见 .github/workflows/release.yml）

/// 比较两个版本号：返回负数表示 a 旧于 b。数字段逐段比；带 `-` 预览后缀的比同号的正式版旧。
int compareVersions(String a, String b) {
  List<int> nums(String v) => v.split('-').first.split('.').map((s) => int.tryParse(s) ?? 0).toList();
  final x = nums(a), y = nums(b);
  for (var i = 0; i < (x.length > y.length ? x.length : y.length); i++) {
    final d = (i < x.length ? x[i] : 0) - (i < y.length ? y[i] : 0);
    if (d != 0) return d;
  }
  final px = a.contains('-'), py = b.contains('-');
  if (px == py) return 0;
  return px ? -1 : 1;
}

/// SHA256SUMS 的内容 → { 文件名: 哈希 }（sha256sum 的格式：`<哈希>  <文件名>`）。
Map<String, String> parseSums(String text) {
  final m = <String, String>{};
  for (final line in const LineSplitter().convert(text)) {
    final parts = line.trim().split(RegExp(r'\s+'));
    if (parts.length >= 2 && parts[0].length == 64) m[parts.sublist(1).join(' ').replaceFirst('*', '')] = parts[0].toLowerCase();
  }
  return m;
}

/// GitHub 上的一个发布：版本、说明页、这台机器用的 APK 与校验文件。
class AppRelease {
  final String version, tag, url;
  final String? apkUrl, apkName, sumsUrl;
  final String? apkUrlFallback, sumsUrlFallback; // 镜像源给出的原 GitHub 地址：镜像失败时退回
  final int apkSize;
  AppRelease({required this.version, required this.tag, required this.url, this.apkUrl, this.apkName, this.sumsUrl, this.apkSize = 0, this.apkUrlFallback, this.sumsUrlFallback});

  /// 从 GitHub `releases/latest` 的 JSON 挑出 APK（`-android-<arch>.apk`，没有同架构的就退到任意 .apk）与 SHA256SUMS。
  factory AppRelease.fromJson(Map j, {String arch = apkArch}) {
    final tag = '${j['tag_name'] ?? ''}';
    final assets = ((j['assets'] as List?) ?? []).whereType<Map>().toList();
    Map? apk = assets.where((a) => '${a['name']}'.toLowerCase().endsWith('-android-$arch.apk')).firstOrNull
        ?? assets.where((a) => '${a['name']}'.toLowerCase().endsWith('.apk')).firstOrNull;
    final sums = assets.where((a) => '${a['name']}'.toUpperCase() == 'SHA256SUMS').firstOrNull;
    return AppRelease(
      version: tag.replaceFirst(RegExp(r'^[vV]'), ''), tag: tag, url: '${j['html_url'] ?? 'https://github.com/$githubRepo/releases'}',
      apkUrl: apk?['browser_download_url'] as String?, apkName: apk?['name'] as String?, apkSize: (apk?['size'] as num?)?.toInt() ?? 0,
      sumsUrl: sums?['browser_download_url'] as String?,
      apkUrlFallback: apk?['github_download_url'] as String?, sumsUrlFallback: sums?['github_download_url'] as String?,
    );
  }
  String get sizeText => apkSize <= 0 ? '' : '${(apkSize / 1048576).toStringAsFixed(apkSize >= 104857600 ? 0 : 1)} MB';
}

enum UpdateState { idle, checking, upToDate, available, downloading, verifying, needPermission, handedOff, failed }

class AppUpdater extends ChangeNotifier {
  static const _ch = MethodChannel('quetzal/updater');
  static const _prefInstalling = 'appUpdate.installingFrom';

  UpdateState state = UpdateState.idle;
  String? current; // 正在运行的 App 版本（versionName）
  AppRelease? latest;
  double progress = 0; // 下载进度 0..1；总长未知时为 -1
  String? error;
  File? _apk; // 已下载并核对过的 APK
  bool dismissed = false; // 外壳横幅被关掉（本次运行内）

  bool get hasUpdate => latest != null && current != null && compareVersions(latest!.version, current!) > 0;

  Future<String?> currentVersion() async {
    if (!hasBody) return null;
    try { return current = await _ch.invokeMethod<String>('version'); } catch (_) { return null; }
  }

  /// 正在忙（检查、下载、核对中）：不重复发起。
  bool get busy => state == UpdateState.checking || state == UpdateState.downloading || state == UpdateState.verifying;

  /// 每次打开界面（启动、从后台回来）都检查一次；正在忙或正等用户去设置里允许安装时不打扰。
  Future<void> autoCheck() async {
    if (!hasBody || busy || state == UpdateState.needPermission) return;
    await check();
  }

  /// 从后台回来：刚从「允许安装未知应用」的设置页回来就接着装；否则照常检查新版。
  Future<void> onResume() async {
    if (state == UpdateState.needPermission) {
      if (await _ch.invokeMethod<bool>('canInstall') ?? false) await install();
      return;
    }
    await autoCheck();
  }

  /// 问 GitHub 最新的正式版（`releases/latest` 不含预览版与草稿）。同一时刻只有一个检查在进行。
  Future<void> check() async {
    if (!hasBody || busy) return;
    state = UpdateState.checking; error = null; notifyListeners();
    try {
      await currentVersion();
      Map j;
      try { j = await fetchJson(Uri.parse(siteLatestApi)); } catch (_) { j = await fetchJson(Uri.parse(latestReleaseApi)); } // 官网镜像源优先，退回 GitHub
      latest = AppRelease.fromJson(j);
      state = hasUpdate ? UpdateState.available : UpdateState.upToDate;
    } catch (e) { _fail('$e'); return; }
    notifyListeners();
  }

  /// 一键：下载 → 核对 → 交给系统安装器。需要「允许安装未知应用」时先带去设置页，回来再点一次即继续（APK 已在本机）。
  Future<void> downloadAndInstall() async {
    final r = latest;
    if (r == null || r.apkUrl == null) { _fail('这个版本没有安卓安装包'); return; }
    try {
      if (_apk == null || !await _apk!.exists()) {
        state = UpdateState.downloading; progress = 0; error = null; notifyListeners();
        final dir = Directory('${await _ch.invokeMethod<String>('cacheDir')}/update');
        if (await dir.exists()) await dir.delete(recursive: true); // 只留这一个包
        final f = File('${dir.path}/${r.apkName}');
        Future<String> dl(String u) => download(Uri.parse(u), f, onProgress: (got, total) { progress = total > 0 ? got / total : -1; notifyListeners(); });
        String sha;
        try { sha = await dl(r.apkUrl!); } catch (e) { if (r.apkUrlFallback == null || r.apkUrlFallback == r.apkUrl) rethrow; progress = 0; notifyListeners(); sha = await dl(r.apkUrlFallback!); } // 镜像失败退回 GitHub
        state = UpdateState.verifying; notifyListeners();
        if (r.sumsUrl != null) {
          List<int> raw;
          try { raw = await fetchBytes(Uri.parse(r.sumsUrl!)); } catch (e) { if (r.sumsUrlFallback == null || r.sumsUrlFallback == r.sumsUrl) rethrow; raw = await fetchBytes(Uri.parse(r.sumsUrlFallback!)); }
          final sums = parseSums(utf8.decode(raw));
          final want = sums[r.apkName];
          if (want != null && want != sha) { await f.delete(); throw '安装包校验不通过（SHA256 与发布页不一致），已删除'; }
        }
        _apk = f;
      }
      await install();
    } on Object catch (e) { _fail('$e'); }
  }

  /// 把已下载的 APK 交给系统安装器（下载好之后或者从设置页允许安装回来后）。
  Future<void> install() async {
    final f = _apk;
    if (f == null) return downloadAndInstall();
    if (!(await _ch.invokeMethod<bool>('canInstall') ?? false)) {
      state = UpdateState.needPermission; notifyListeners();
      await _ch.invokeMethod('requestInstallPermission');
      return;
    }
    final p = await SharedPreferences.getInstance();
    await p.setString(_prefInstalling, current ?? '');
    await _ch.invokeMethod('install', {'path': f.path});
    state = UpdateState.handedOff; notifyListeners();
  }

  /// 刚从旧版本更新上来？（上一次点了「安装」且现在的版本与那时不同）只回答一次：读到就清掉。
  Future<bool> justUpdated() async {
    if (!hasBody) return false;
    final p = await SharedPreferences.getInstance();
    final from = p.getString(_prefInstalling);
    if (from == null) return false;
    await p.remove(_prefInstalling);
    return (await currentVersion()) != from;
  }

  void _fail(String msg) {
    error = msg.replaceFirst(RegExp(r'^(Exception|Bad state|Invalid argument\(s\)): '), '');
    state = UpdateState.failed; notifyListeners();
  }

  // ---- 网络（纯函数，便于测试）
  static HttpClient _client() => HttpClient()..connectionTimeout = const Duration(seconds: 15)..userAgent = 'quetzal-console';

  static Future<Map> fetchJson(Uri url) async {
    final j = jsonDecode(utf8.decode(await fetchBytes(url, accept: 'application/vnd.github+json')));
    if (j is! Map) throw '接口返回的不是对象';
    return j;
  }

  static Future<List<int>> fetchBytes(Uri url, {String? accept}) async {
    final c = _client();
    try {
      final req = await c.getUrl(url);
      if (accept != null) req.headers.set(HttpHeaders.acceptHeader, accept);
      final res = await req.close().timeout(const Duration(seconds: 30));
      if (res.statusCode == 403 || res.statusCode == 429) throw '更新服务暂时繁忙，稍后再试';
      if (res.statusCode != 200) throw 'HTTP ${res.statusCode}';
      return await res.fold<List<int>>(<int>[], (a, b) => a..addAll(b));
    } on SocketException { throw '网络连接失败'; } on TimeoutException { throw '网络响应超时'; } finally { c.close(force: true); }
  }

  /// 下载到文件，边写边报进度，返回内容的 SHA256（十六进制）。跟随 GitHub 资产的 302 跳转。
  static Future<String> download(Uri url, File dest, {void Function(int got, int total)? onProgress}) async {
    final c = _client();
    try {
      final req = await c.getUrl(url);
      final res = await req.close().timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) throw '下载失败：HTTP ${res.statusCode}';
      await dest.parent.create(recursive: true);
      final sink = dest.openWrite();
      var got = 0;
      final total = res.contentLength;
      try {
        await for (final chunk in res.timeout(const Duration(seconds: 60))) {
          sink.add(chunk); got += chunk.length; onProgress?.call(got, total);
        }
      } finally { await sink.close(); }
      if (total > 0 && got != total) throw '下载不完整（$got / $total 字节）';
      return (await sha256.bind(dest.openRead()).first).toString();
    } on SocketException { throw '连不上 ${url.host}'; } on TimeoutException { throw '下载超时（${url.host}）'; } finally { c.close(force: true); }
  }
}

final appUpdater = AppUpdater();
