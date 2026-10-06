// 打开外部链接的唯一入口：只放行 https（http 只限本机回环地址）。
//   链接可能来自网关、同步服务或 agent 写的 Markdown，不能让它们借控制台打开 intent://、file://、javascript: 之类的地址。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'widgets.dart';

/// 允许交给系统打开的地址；不允许时返回 null。
Uri? safeExternalUri(String raw) {
  final u = Uri.tryParse(raw.trim());
  if (u == null || u.host.isEmpty || u.userInfo.isNotEmpty) return null;
  if (u.scheme == 'https') return u;
  if (u.scheme == 'http' && const {'localhost', '127.0.0.1', '::1', '[::1]'}.contains(u.host)) return u;
  return null;
}

/// 用外部浏览器打开；地址不被允许时提示而不打开。这台设备没有浏览器（精简过的手机常见）时复制链接，让人在别的设备上打开。
Future<void> openExternal(BuildContext context, String raw) async {
  final u = safeExternalUri(raw);
  if (u == null) { toast(context, '不打开这个链接：只允许 https 地址'); return; }
  var ok = false;
  try { ok = await launchUrl(u, mode: LaunchMode.externalApplication); } catch (_) {}
  if (ok) return;
  await Clipboard.setData(ClipboardData(text: raw));
  if (context.mounted) toast(context, '这台设备打不开链接，已复制，换一台设备打开或扫码');
}
