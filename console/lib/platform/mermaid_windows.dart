// Windows 桌面版：WebView2（webview_windows，画面以纹理嵌进 Flutter）加载内置的 view.html。
//   页面经虚拟主机映射到安装目录里的 data\flutter_assets\assets\mermaid\（只读本地文件，不走网络；NavigateToString 有 2 MB 上限，装不下 mermaid.js），
//   宿主等页面回报 ready 后调用 render()，页面回报高度；内嵌时不接收指针（点一下全屏），全屏时可滚动、Ctrl+滚轮缩放；弹窗一律拒绝。
//   WebView2 的数据目录放在 %LOCALAPPDATA%\Quetzal\console\webview2。这台电脑没有 WebView2 运行时（少数精简过的 Windows 10）时改由运行基座画。
import 'dart:async';
import 'dart:convert';
import 'dart:io' show File, Platform;
import 'package:flutter/material.dart';
import 'package:webview_windows/webview_windows.dart';
import 'mermaid_common.dart';
import 'mermaid_gateway.dart';

const _host = 'quetzal-mermaid.example'; // .example 是保留的域名，不会与真实网站冲突

Future<bool>? _ready;
/// WebView2 运行时在不在；第一次调用时初始化共享的 WebView2 环境（数据目录）。
Future<bool> webView2Available() => _ready ??= () async {
  try {
    if (await WebviewController.getWebViewVersion() == null) return false;
    final local = Platform.environment['LOCALAPPDATA'];
    if (local != null && local.isNotEmpty) await WebviewController.initializeEnvironment(userDataPath: '$local\\Quetzal\\console\\webview2');
    return true;
  } catch (e) {
    debugPrint('WebView2 不可用：$e');
    return false;
  }
}();

class WindowsMermaid extends StatefulWidget {
  final String code;
  final bool fullscreen;
  const WindowsMermaid(this.code, {super.key, this.fullscreen = false});
  @override
  State<WindowsMermaid> createState() => _WindowsMermaidState();
}

class _WindowsMermaidState extends State<WindowsMermaid> {
  static final _heights = <String, double>{};
  final c = WebviewController();
  StreamSubscription? _sub;
  bool ready = false, fallback = false, _disposed = false, _started = false;
  String? error;

  @override
  void initState() { super.initState(); _init(); }

  Future<void> _init() async {
    if (!await webView2Available()) { if (mounted) setState(() => fallback = true); return; }
    if (_disposed) return;
    try {
      _started = true;
      await c.initialize();
      if (_disposed) return;
      await c.setBackgroundColor(Colors.transparent);
      await c.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
      _sub = c.webMessage.listen(_onMessage, onError: (_) {});
      final dir = '${File(Platform.resolvedExecutable).parent.path}\\data\\flutter_assets\\assets\\mermaid';
      await c.addVirtualHostNameMapping(_host, dir, WebviewHostResourceAccessKind.deny);
      await c.loadUrl('https://$_host/view.html');
      if (mounted) setState(() => ready = true);
    } catch (e) {
      debugPrint('WebView2 起不来：$e');
      if (mounted) setState(() => fallback = true);
    }
  }

  void _onMessage(dynamic raw) {
    if (!mounted) return;
    Map j;
    try { j = (raw is String ? jsonDecode(raw) : raw) as Map; } catch (_) { return; }
    if (j['ready'] == true) {
      final dark = Theme.of(context).brightness == Brightness.dark;
      c.executeScript('render(${jsonEncode(widget.code)}, $dark, ${!widget.fullscreen})');
    } else if (j['error'] != null) {
      setState(() => error = '${j['error']}');
    } else if (j['h'] != null) {
      setState(() => putBounded(_heights, widget.code, (j['h'] as num).toDouble() + 8, max: 200));
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _sub?.cancel();
    if (_started) c.dispose().catchError((Object e) => debugPrint('WebView2 释放失败：$e')); // 没初始化过的控制器不能释放
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (fallback) return GatewayMermaid(widget.code, fullscreen: widget.fullscreen);
    if (error != null) return MermaidFailed(widget.code, error: error);
    final view = ready ? Webview(c) : const Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)));
    if (widget.fullscreen) return view;
    return SizedBox(
      height: _heights[widget.code] ?? 160,
      child: Stack(children: [
        view,
        // 覆盖一层：点击全屏，滚轮与拖动仍交给列表
        Positioned.fill(child: tapToFullscreen(context, const SizedBox.expand(), () => WindowsMermaid(widget.code, fullscreen: true))),
      ]),
    );
  }
}
