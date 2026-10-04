// 完整的 Markdown 渲染：GFM（标题、列表、任务列表、表格、代码块、引用、链接、删除线…）
// + LaTeX 公式（行内 $…$ / \(…\)，独立 $$…$$ / \[…\]，原生排版）
// + Mermaid 图（```mermaid：流程图、时序图、甘特图、类图、状态图、思维导图、框图、饼图……，用内置的 mermaid.js 渲染，离线可用；安卓在 WebView 里，网页版在 iframe 里，见 platform/mermaid.dart）。
// 做法：先把 Mermaid 代码块与独立公式块切成单独的片段，其余交给 Markdown；行内公式通过自定义语法进入 Markdown。
// 控制台里凡是她写的文字（回复、日记、笔记、记忆条目、想分享的一句话、理由）都经 RichMarkdown 渲染；工具输出经 RawOrMarkdown；只能放一行的地方用 plainPreview。
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';
import 'platform/mermaid.dart';
export 'platform/mermaid.dart' show MermaidView;

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

/// 去掉 Markdown 标记，用于只能放一行的地方：列表里的预览、通知条、首页那句话的折叠预览。
String plainPreview(String md) => md
    .replaceAll(RegExp(r'```[\s\S]*?(```|$)'), ' ')
    .replaceAll(RegExp(r'^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+|\|)', multiLine: true), '')
    .replaceAllMapped(RegExp(r'!?\[([^\]]*)\]\([^)]*\)'), (m) => m.group(1)!)
    .replaceAll(RegExp(r'[*_`~]+'), '')
    .replaceAll(RegExp(r'\s+'), ' ')
    .trim();

/// 一段文字是否像 Markdown（标题、列表、引用、围栏、表格、粗体、行内代码、链接）。
bool looksLikeMarkdown(String t) =>
    RegExp(r'(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.*\|)|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)').hasMatch(t);

/// 工具的参数与结果、审计里的输出：像 Markdown 就按 Markdown 渲染（笔记、她写的说明），否则按原样等宽显示（shell 输出、JSON），不让换行与空格被吞掉。
class RawOrMarkdown extends StatelessWidget {
  final String text;
  const RawOrMarkdown(this.text, {super.key});
  @override
  Widget build(BuildContext context) => looksLikeMarkdown(text)
      ? RichMarkdown(text)
      : SelectableText(text, style: Theme.of(context).textTheme.bodySmall?.copyWith(fontFamily: 'monospace'));
}

/// 渲染一段 Markdown。live：正在流式输出时为真，此时 Mermaid 先按代码显示，结束后再渲染成图。
/// selectable：默认可选中文字；放在可点击的列表项里时关掉，否则点击会被文字选择吃掉。
/// 单个换行按换行显示（softLineBreak）：她的日记、笔记与回复都是按行写的。
class RichMarkdown extends StatelessWidget {
  final String text;
  final bool live, selectable;
  const RichMarkdown(this.text, {super.key, this.live = false, this.selectable = true});

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
                    onErrorFallback: (_) => selectable ? SelectableText(s.text) : Text(s.text))),
              ),
            ),
          _ => _markdown(s.text, sheet),
        },
    ]);
  }

  Widget _markdown(String data, MarkdownStyleSheet sheet) => MarkdownBody(
        data: data,
        selectable: selectable,
        softLineBreak: true,
        styleSheet: sheet,
        extensionSet: md.ExtensionSet(
          md.ExtensionSet.gitHubFlavored.blockSyntaxes,
          [_InlineMath(), ...md.ExtensionSet.gitHubFlavored.inlineSyntaxes],
        ),
        builders: {'math': _MathBuilder()},
        onTapLink: (_, href, _) { if (href != null) launchUrl(Uri.parse(href), mode: LaunchMode.externalApplication); },
      );
}
