// 兜底：这台电脑没有能用的网页引擎（Linux 没装 WebKitGTK、Windows 没有 WebView2 运行时）时，请运行基座把图画成 SVG——
//   网关方法 mermaid.render {code, dark} → {svg}，由 flutter_svg 显示。flutter_svg 不支持 <style>、CSS 变量、<marker> 与 foreignObject，
//   所以运行基座给的 SVG 要是「自包含的静态 SVG」：颜色写成具体值、箭头画成路径、文字用 <text>（见 console/docs/ARCHITECTURE.md）。
//   旧版运行基座没有这个方法、或画不出来时显示源码。
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import '../api.dart';
import 'mermaid_common.dart';

class GatewayMermaid extends StatefulWidget {
  final String code;
  final bool fullscreen;
  const GatewayMermaid(this.code, {super.key, this.fullscreen = false});
  @override
  State<GatewayMermaid> createState() => _GatewayMermaidState();
}

class _GatewayMermaidState extends State<GatewayMermaid> {
  static final _cache = <String, Future<String>>{}; // dark|code → svg（失败的不留，运行基座升级后再试）
  Future<String>? _svg;
  bool? _dark;

  Future<String> _fetch(bool dark) {
    final key = '$dark|${widget.code}';
    final hit = _cache[key];
    if (hit != null) return hit;
    final f = api.call<Map>('mermaid.render', {'code': widget.code, 'dark': dark}).then((r) {
      final svg = r['svg'];
      if (svg is! String || svg.isEmpty) throw RpcError('MERMAID', '运行基座没有给出图');
      return svg;
    });
    putBounded(_cache, key, f);
    f.catchError((_) { _cache.remove(key); return ''; });
    return f;
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    if (_svg == null || _dark != dark) { _dark = dark; _svg = _fetch(dark); }
    return FutureBuilder<String>(
      future: _svg,
      builder: (context, s) {
        if (s.hasError) return MermaidFailed(widget.code, error: s.error is RpcError && (s.error as RpcError).code == 'OFFLINE' ? '未连接' : null);
        if (!s.hasData) return const SizedBox(height: 120, child: Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))));
        final pic = SvgPicture.string(s.data!, errorBuilder: (_, e, _) => MermaidFailed(widget.code));
        if (widget.fullscreen) return InteractiveViewer(maxScale: 6, boundaryMargin: const EdgeInsets.all(200), child: Center(child: pic));
        return tapToFullscreen(context, ConstrainedBox(constraints: const BoxConstraints(maxHeight: 560), child: FittedBox(fit: BoxFit.scaleDown, child: pic)),
            () => GatewayMermaid(widget.code, fullscreen: true));
      },
    );
  }
}
