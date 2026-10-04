// 安卓：WebView 加载内置的 view.html 渲染，高度自适应；点击全屏查看（可缩放）。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

class MermaidView extends StatefulWidget {
  final String code;
  final bool fullscreen;
  const MermaidView(this.code, {super.key, this.fullscreen = false});
  @override
  State<MermaidView> createState() => _MermaidViewState();
}

class _MermaidViewState extends State<MermaidView> {
  static final _heights = <String, double>{}; // 渲染过的图记住高度，列表回滚时不跳动
  late final WebViewController c;
  String? error;

  @override
  void initState() {
    super.initState();
    c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.transparent)
      ..enableZoom(widget.fullscreen)
      ..addJavaScriptChannel('Out', onMessageReceived: _onMessage)
      ..setOnConsoleMessage((m) => debugPrint('mermaid console: ${m.message}'))
      ..loadFlutterAsset('assets/mermaid/view.html');
  }

  void _onMessage(JavaScriptMessage m) {
    final j = jsonDecode(m.message) as Map;
    if (j['error'] != null) debugPrint('mermaid: ${j['error']} ${j['ua'] ?? ''}');
    if (j['ready'] == true) {
      final dark = Theme.of(context).brightness == Brightness.dark;
      c.runJavaScript('render(${jsonEncode(widget.code)}, $dark, ${!widget.fullscreen})');
    } else if (j['h'] != null && mounted) {
      setState(() => _heights[widget.code] = (j['h'] as num).toDouble() + 8);
    } else if (j['error'] != null && mounted) {
      setState(() => error = '${j['error']}');
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.fullscreen) return WebViewWidget(controller: c);
    if (error != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('图表无法渲染：$error', style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
        SelectableText(widget.code, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
      ]);
    }
    final h = _heights[widget.code] ?? 160;
    return SizedBox(
      height: h,
      child: Stack(children: [
        WebViewWidget(controller: c),
        // 覆盖一层：点击全屏，纵向拖动仍交给列表
        Positioned.fill(child: GestureDetector(behavior: HitTestBehavior.translucent, onTap: () => Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => Scaffold(appBar: AppBar(title: const Text('图表')), body: MermaidView(widget.code, fullscreen: true)))))),
      ]),
    );
  }
}
