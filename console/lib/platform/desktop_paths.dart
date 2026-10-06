// 原生桌面控制台（Linux / Windows）的目录约定。这里只有纯函数：不读环境变量、不碰文件系统（由调用方传入），方便测试。
//   Linux：QUETZAL_HOME 缺省 ~/.quetzal；一键安装脚本把控制台放在 ~/.quetzal/console/<版本>/，console/current 是指向当前版本目录的符号链接。
//   Windows（docs/WINDOWS_DECISIONS.md 4.1）：ROOT = %LOCALAPPDATA%\Quetzal；QUETZAL_HOME 缺省 ROOT\home；
//     控制台在 ROOT\console\<版本>\quetzal-console.exe，ROOT\console\current.txt 一行写着当前版本（指针文件代替符号链接：
//     正在运行的 exe 删不掉也改不了名，所以「换了新版本」只能按指针判断）；运行基座在 ROOT\runtime\<版本>\，ROOT\runtime\current.txt 同理；
//     ROOT\node.txt 是运行基座用的 node.exe 的绝对路径（安装器写入）。

/// 一台桌面机器上的 Quetzal 目录。[env] 为进程环境变量（测试里传构造的）。
class DesktopLayout {
  final bool windows;
  final Map<String, String> env;
  const DesktopLayout({required this.windows, required this.env});

  String get sep => windows ? r'\' : '/';
  String join(List<String> parts) => parts.join(sep);

  /// Windows 的安装根目录 %LOCALAPPDATA%\Quetzal；Linux 没有这个概念（null）。
  String? get root {
    if (!windows) return null;
    final l = env['LOCALAPPDATA'];
    return l == null || l.trim().isEmpty ? null : join([_trimSep(l.trim()), 'Quetzal']);
  }

  /// 运行基座的家目录：环境变量 QUETZAL_HOME 优先（与运行基座的 config.ts 一致）；否则 Linux 为 ~/.quetzal，Windows 为 ROOT\home。
  String? get home {
    final h = env['QUETZAL_HOME'];
    if (h != null && h.trim().isNotEmpty) return _trimSep(h.trim());
    if (windows) { final r = root; return r == null ? null : join([r, 'home']); }
    final u = env['HOME'];
    return u == null || u.trim().isEmpty ? null : join([_trimSep(u.trim()), '.quetzal']);
  }

  /// 网关令牌：QUETZAL_HOME/secrets/gateway.token（运行基座第一次启动时生成）。
  String? get gatewayToken { final h = home; return h == null ? null : join([h, 'secrets', 'gateway.token']); }

  /// Windows：控制台、运行基座的版本指针与 node 路径文件。
  String? get consolePointer { final r = root; return r == null ? null : join([r, 'console', 'current.txt']); }
  String? get runtimePointer { final r = root; return r == null ? null : join([r, 'runtime', 'current.txt']); }
  String? get nodePointer { final r = root; return r == null ? null : join([r, 'node.txt']); }

  /// Windows：身体助手 `"<node>" ROOT\runtime\<版本>\windows-body.mjs`（docs/WINDOWS_DECISIONS.md 4.3）。
  /// [nodeTxt]、[runtimeCurrentTxt] 为 node.txt 与 runtime\current.txt 的内容；缺任何一样返回 null。
  BodyHelperCommand? bodyHelper({required String? nodeTxt, required String? runtimeCurrentTxt}) {
    final r = root, v = parsePointer(runtimeCurrentTxt), node = nodeTxt?.trim().split(RegExp(r'[\r\n]')).first.trim();
    if (r == null || v == null || node == null || node.isEmpty) return null;
    return BodyHelperCommand(node, join([r, 'runtime', v, 'windows-body.mjs']), v);
  }

  static String _trimSep(String p) => p.length > 1 && (p.endsWith('/') || p.endsWith(r'\')) && !RegExp(r'^[A-Za-z]:[\\/]$').hasMatch(p) ? p.substring(0, p.length - 1) : p;
}

/// 身体助手的启动命令：node 的路径、脚本路径，以及它属于哪个运行基座版本（版本变了要换新的）。
class BodyHelperCommand {
  final String node, script, version;
  const BodyHelperCommand(this.node, this.script, this.version);
  @override
  bool operator ==(Object other) => other is BodyHelperCommand && other.node == node && other.script == script && other.version == version;
  @override
  int get hashCode => Object.hash(node, script, version);
}

/// 指针文件（current.txt）的内容 → 版本目录名：取第一行、去掉空白（含 UTF-8 BOM）；空的、带路径分隔符或 `..` 的一律不算（返回 null）。
String? parsePointer(String? text) {
  if (text == null) return null;
  final v = text.replaceFirst('﻿', '').split(RegExp(r'[\r\n]')).first.trim();
  if (v.isEmpty || v.contains('/') || v.contains(r'\') || v == '.' || v == '..' || v.contains(':')) return null;
  return v;
}

/// 路径的上一级（同时认 / 与 \）。
String parentDir(String p) {
  final i = p.lastIndexOf(RegExp(r'[\\/]'));
  return i <= 0 ? p : p.substring(0, i);
}

/// 路径的最后一段。
String baseName(String p) {
  final i = p.lastIndexOf(RegExp(r'[\\/]'));
  return i < 0 ? p : p.substring(i + 1);
}

/// Windows：正在跑的 [exe]（…\console\<版本>\quetzal-console.exe）是不是旧版本——
/// [consoleCurrentTxt] 为同一个 console 目录下 current.txt 的内容；没有指针（不是安装器的布局）时为假。版本目录名不分大小写。
bool windowsConsoleStale(String exe, String? consoleCurrentTxt) {
  final v = parsePointer(consoleCurrentTxt);
  if (v == null) return false;
  return v.toLowerCase() != baseName(parentDir(exe)).toLowerCase();
}

/// Windows：当前版本的控制台 exe（console\<current.txt 的版本>\quetzal-console.exe）；没有指针时为 null。
String? windowsCurrentConsole(String exe, String? consoleCurrentTxt) {
  final v = parsePointer(consoleCurrentTxt);
  if (v == null) return null;
  return '${parentDir(parentDir(exe))}\\$v\\quetzal-console.exe';
}

/// 看护子进程的退避：第 [failures] 次连续失败后等多久再拉起（1、2、4…最多 60 秒）。
Duration restartBackoff(int failures) => Duration(seconds: failures <= 0 ? 1 : (1 << (failures.clamp(1, 7) - 1)).clamp(1, 60));
