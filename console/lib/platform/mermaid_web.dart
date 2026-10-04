// 网页版：同源的 iframe 加载 assets/mermaid/view.html，用 postMessage 交换「渲染」与「高度」。
//   内嵌时 iframe 不接收指针事件（点击交给 Flutter 的覆盖层→全屏对话框）；全屏时 iframe 可滚动、可缩放。
import 'dart:convert';
import 'dart:js_interop';
import 'dart:ui_web' as ui_web;
import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

class MermaidView extends StatefulWidget {
  final String code;
  final bool fullscreen;
  const MermaidView(this.code, {super.key, this.fullscreen = false});
  @override
  State<MermaidView> createState() => _MermaidViewState();
}

class _MermaidViewState extends State<MermaidView> {
  static final _heights = <String, double>{};
  static int _seq = 0;
  late final String viewType;
  late final web.HTMLIFrameElement iframe;
  late final JSFunction _listener;
  String? error;

  @override
  void initState() {
    super.initState();
    viewType = 'quetzal-mermaid-${++_seq}';
    iframe = web.HTMLIFrameElement()
      ..src = 'assets/assets/mermaid/view.html'
      ..style.border = '0'
      ..style.width = '100%'
      ..style.height = '100%'
      ..style.background = 'transparent'
      ..style.pointerEvents = widget.fullscreen ? 'auto' : 'none';
    iframe.setAttribute('allowtransparency', 'true');
    ui_web.platformViewRegistry.registerViewFactory(viewType, (int id) => iframe);
    _listener = ((web.MessageEvent e) {
      final d = e.data;
      if (d == null || !d.typeofEquals('string')) return;
      Map j;
      try { j = jsonDecode((d as JSString).toDart) as Map; } catch (_) { return; }
      if (j['id'] != viewType || !mounted) return;
      if (j['h'] != null) setState(() => _heights[widget.code] = (j['h'] as num).toDouble() + 8);
      if (j['error'] != null) setState(() => error = '${j['error']}');
    }).toJS;
    web.window.addEventListener('message', _listener);
    iframe.addEventListener('load', ((web.Event _) {
      final dark = Theme.of(context).brightness == Brightness.dark;
      iframe.contentWindow?.postMessage(jsonEncode({'id': viewType, 'render': widget.code, 'dark': dark, 'fit': !widget.fullscreen}).toJS, '*'.toJS);
    }).toJS);
  }

  @override
  void dispose() { web.window.removeEventListener('message', _listener); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    if (widget.fullscreen) return HtmlElementView(viewType: viewType);
    if (error != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('图表无法渲染：$error', style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
        SelectableText(widget.code, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
      ]);
    }
    return SizedBox(
      height: _heights[widget.code] ?? 160,
      child: Stack(children: [
        HtmlElementView(viewType: viewType),
        Positioned.fill(child: GestureDetector(behavior: HitTestBehavior.translucent, onTap: () => showDialog(context: context, builder: (x) => Dialog.fullscreen(
            child: Column(children: [
              AppBar(title: const Text('图表'), leading: IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(x))),
              Expanded(child: MermaidView(widget.code, fullscreen: true)),
            ]))))),
      ]),
    );
  }
}
