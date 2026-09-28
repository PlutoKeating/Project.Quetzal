// 完整的 Markdown 渲染：GFM（标题、列表、任务列表、表格、代码块、引用、链接、删除线…）
// + LaTeX 公式（行内 $…$ / \(…\)，独立 $$…$$ / \[…\]，原生排版）
// + Mermaid 图（```mermaid：流程图、时序图、甘特图、类图、状态图、思维导图、框图、饼图……，在 WebView 中用内置的 mermaid.js 渲染，离线可用）。
// 做法：先把 Mermaid 代码块与独立公式块切成单独的片段，其余交给 Markdown；行内公式通过自定义语法进入 Markdown。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// 片段：markdown / mermaid / math（独立公式）。
typedef Segment = ({String kind, String text});

/// 把文本切成片段：代码围栏内的内容原样保留，只有语言为 mermaid 的围栏单独成段；围栏外独占行的 $$…$$ 与 \[…\] 成为公式段。
List<Segment> splitSegments(String src) {
  final out = <Segment>[];
  final buf = <String>[];
  void flush() {
    if (buf.isNotEmpty) { out.add((kind: 'markdown', text: buf.join('\n'))); buf.clear(); }
  }
  final lines = src.split('\n');
  final fence = RegExp(r'^\s*(`{3,}|~{3,})\s*([\w-]*)');
  for (var i = 0; i < lines.length; i++) {
    final l = lines[i], t = l.trim();
    final f = fence.firstMatch(l);
    if (f != null) {
      final mark = f.group(1)!, lang = f.group(2)!.toLowerCase();
      final body = <String>[];
      var j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(mark)) { body.add(lines[j]); j++; }
      if (lang == 'mermaid' && j < lines.length) {
        flush();
        out.add((kind: 'mermaid', text: body.join('\n')));
      } else {
        buf.addAll(lines.sublist(i, j < lines.length ? j + 1 : j));
      }
      i = j;
      continue;
    }
    String? close;
    if (t.startsWith(r'$$')) close = r'$$';
    if (t.startsWith(r'\[')) close = r'\]';
    if (close != null) {
      final open = t.substring(0, 2);
      final rest = t.substring(2);
      if (rest.trimRight().endsWith(close) && rest.trim().length >= 2) { // 单行：$$ … $$
        flush();
        out.add((kind: 'math', text: rest.trimRight().substring(0, rest.trimRight().length - 2).trim()));
        continue;
      }
      final body = <String>[if (rest.trim().isNotEmpty) rest];
      var j = i + 1;
      while (j < lines.length && !lines[j].trimRight().endsWith(close)) { body.add(lines[j]); j++; }
      if (j < lines.length) {
        final last = lines[j].trimRight();
        body.add(last.substring(0, last.length - 2));
        flush();
        out.add((kind: 'math', text: body.join('\n').trim()));
        i = j;
        continue;
      }
      buf.add(open == r'$$' ? l : l); // 未闭合：当普通文本
      continue;
    }
    buf.add(l);
  }
  flush();
  return out;
}

/// 行内公式：$…$（两侧不紧挨空白，避免把金额当公式）、\(…\)、以及行内的 $$…$$。
class _InlineMath extends md.InlineSyntax {
  _InlineMath() : super(r'\$\$([^$]+?)\$\$|\\\((.+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)');
  @override
  bool onMatch(md.InlineParser parser, Match m) {
    final display = m.group(1) != null;
    parser.addNode(md.Element.text('math', m.group(1) ?? m.group(2) ?? m.group(3)!)..attributes['display'] = '$display');
    return true;
  }
}

class _MathBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(BuildContext context, md.Element element, TextStyle? preferredStyle, TextStyle? parentStyle) {
    final display = element.attributes['display'] == 'true';
    final style = parentStyle ?? DefaultTextStyle.of(context).style;
    return Text.rich(TextSpan(children: [
      WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Math.tex(element.textContent, mathStyle: display ? MathStyle.display : MathStyle.text, textStyle: style,
              onErrorFallback: (_) => Text(element.textContent, style: style)),
        ),
      ),
    ]));
  }
}

/// 渲染一段 Markdown。live：正在流式输出时为真，此时 Mermaid 先按代码显示，结束后再渲染成图。
class RichMarkdown extends StatelessWidget {
  final String text;
  final bool live;
  const RichMarkdown(this.text, {super.key, this.live = false});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context), cs = theme.colorScheme;
    final sheet = MarkdownStyleSheet.fromTheme(theme).copyWith(
      p: theme.textTheme.bodyMedium,
      code: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace', backgroundColor: cs.surfaceContainerLow),
      codeblockDecoration: BoxDecoration(color: cs.surfaceContainerLow, borderRadius: BorderRadius.circular(8)),
      blockquoteDecoration: BoxDecoration(border: Border(left: BorderSide(color: cs.outline, width: 3))),
      tableColumnWidth: const IntrinsicColumnWidth(), // 宽表格可横向滚动
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      tableBorder: TableBorder.all(color: cs.outlineVariant),
      tableHead: const TextStyle(fontWeight: FontWeight.bold),
    );
    final segs = splitSegments(text);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      for (final s in segs)
        switch (s.kind) {
          'mermaid' when !live => MermaidView(s.text),
          'mermaid' => _markdown('```mermaid\n${s.text}\n```', sheet),
          'math' => Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Center(child: Math.tex(s.text, mathStyle: MathStyle.display, textStyle: theme.textTheme.bodyLarge,
                    onErrorFallback: (_) => SelectableText(s.text))),
              ),
            ),
          _ => _markdown(s.text, sheet),
        },
    ]);
  }

  Widget _markdown(String data, MarkdownStyleSheet sheet) => MarkdownBody(
        data: data,
        selectable: true,
        styleSheet: sheet,
        extensionSet: md.ExtensionSet(
          md.ExtensionSet.gitHubFlavored.blockSyntaxes,
          [_InlineMath(), ...md.ExtensionSet.gitHubFlavored.inlineSyntaxes],
        ),
        builders: {'math': _MathBuilder()},
        onTapLink: (_, href, _) { if (href != null) launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication); },
      );
}

/// Mermaid 图：WebView 加载内置的 mermaid.js 渲染，高度自适应；点击全屏查看（可缩放）。
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
