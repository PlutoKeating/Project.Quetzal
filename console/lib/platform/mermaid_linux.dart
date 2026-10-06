// Linux 桌面版：运行壳里看不见的 WebKitGTK 跑内置的 mermaid.js，按图的原始尺寸整页截图成 PNG（MethodChannel quetzal/mermaid，
//   见 linux/runner/mermaid_renderer.h），这里显示图片：内嵌时按可用宽度缩小，点开全屏可缩放拖动。
//   这台电脑没有 WebKitGTK（render 返回 unavailable）时改由运行基座画（GatewayMermaid）。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'mermaid_common.dart';
import 'mermaid_gateway.dart';

class MermaidPng {
  final Uint8List png;
  final double scale; // PNG 像素 / CSS 像素
  const MermaidPng(this.png, this.scale);
}

class SnapshotMermaid extends StatefulWidget {
  final String code;
  final bool fullscreen;
  const SnapshotMermaid(this.code, {super.key, this.fullscreen = false});
  @override
  State<SnapshotMermaid> createState() => _SnapshotMermaidState();
}

class _SnapshotMermaidState extends State<SnapshotMermaid> {
  static const _ch = MethodChannel('quetzal/mermaid');
  static final _cache = <String, Future<MermaidPng>>{}; // dark|scale|code → 图（失败的不留）
  static bool _unavailable = false; // 这台电脑没有 WebKitGTK：之后都交给运行基座
  Future<MermaidPng>? _png;
  String? _key;

  Future<MermaidPng> _render(bool dark, double scale) {
    final key = '$dark|$scale|${widget.code}';
    final hit = _cache[key];
    if (hit != null) return hit;
    final f = _ch.invokeMapMethod<String, dynamic>('render', {'code': widget.code, 'dark': dark, 'scale': scale}).then((r) {
      final png = r?['png'];
      if (png is! Uint8List) throw PlatformException(code: 'render', message: '没有拿到图');
      return MermaidPng(png, (r?['scale'] as num?)?.toDouble() ?? scale);
    });
    putBounded(_cache, key, f);
    f.catchError((Object e) {
      _cache.remove(key);
      if (e is PlatformException && e.code == 'unavailable' && mounted) setState(() => _unavailable = true);
      return MermaidPng(Uint8List(0), 1);
    });
    return f;
  }

  /// mermaid 报错时原生侧把 view.html 的 JSON 消息原样交回：取出 error。
  static String _why(Object? e) {
    if (e is PlatformException) {
      final m = e.message ?? '';
      try { final j = jsonDecode(m); if (j is Map && j['error'] != null) return '${j['error']}'; } catch (_) {}
      return m.isEmpty ? e.code : m;
    }
    return '$e';
  }

  @override
  Widget build(BuildContext context) {
    if (_unavailable) return GatewayMermaid(widget.code, fullscreen: widget.fullscreen);
    final dark = Theme.of(context).brightness == Brightness.dark;
    final scale = (MediaQuery.devicePixelRatioOf(context) * 1.5).clamp(2.0, 4.0).toDouble(); // 比屏幕更细一些，全屏放大时也清楚
    final key = '$dark|$scale';
    if (_png == null || _key != key) { _key = key; _png = _render(dark, scale); }
    return FutureBuilder<MermaidPng>(
      future: _png,
      builder: (context, s) {
        if (s.hasError) {
          if (s.error is PlatformException && (s.error as PlatformException).code == 'unavailable') return GatewayMermaid(widget.code, fullscreen: widget.fullscreen);
          return MermaidFailed(widget.code, error: _why(s.error));
        }
        if (!s.hasData) return const SizedBox(height: 120, child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))));
        final img = Image.memory(s.data!.png, scale: s.data!.scale, gaplessPlayback: true, filterQuality: FilterQuality.medium);
        if (widget.fullscreen) return InteractiveViewer(maxScale: 4, boundaryMargin: const EdgeInsets.all(200), child: Center(child: img));
        return tapToFullscreen(context, Align(alignment: Alignment.center, child: ConstrainedBox(constraints: const BoxConstraints(maxHeight: 560), child: FittedBox(fit: BoxFit.scaleDown, child: img))),
            () => SnapshotMermaid(widget.code, fullscreen: true));
      },
    );
  }
}
