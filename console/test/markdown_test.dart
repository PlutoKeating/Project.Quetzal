// Markdown 片段切分：Mermaid 围栏与独立公式单独成段，其余代码围栏原样保留。
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/markdown.dart';

void main() {
  test('Mermaid 围栏单独成段，其他代码围栏保留在 Markdown 中', () {
    final s = splitSegments('前\n```mermaid\ngraph TD\nA-->B\n```\n```dart\nvar a = r"\$\$";\n```\n后');
    expect(s.map((x) => x.kind).toList(), ['markdown', 'mermaid', 'markdown']);
    expect(s[1].text, 'graph TD\nA-->B');
    expect(s[2].text, contains('```dart'));
  });

  test('独立公式：单行 \$\$…\$\$、多行 \$\$ 与 \\[ \\]', () {
    final s = splitSegments('a\n\$\$E=mc^2\$\$\nb\n\$\$\n\\int_0^1 x\\,dx\n\$\$\n\\[\n\\frac{1}{2}\n\\]');
    expect(s.where((x) => x.kind == 'math').map((x) => x.text).toList(), ['E=mc^2', r'\int_0^1 x\,dx', r'\frac{1}{2}']);
  });

  test('未闭合的公式与围栏不丢内容', () {
    final s = splitSegments('价格 \$5\n\$\$ 未闭合\n```mermaid\ngraph TD');
    expect(s.map((x) => x.text).join('\n'), contains('未闭合'));
    expect(s.map((x) => x.text).join('\n'), contains('graph TD'));
  });

  test('一行预览去掉 Markdown 标记', () {
    expect(plainPreview('## 标题\n\n- **粗体** 与 `代码`\n> 引用 [链接](http://x)\n```sh\nls\n```\n尾'), '标题 粗体 与 代码 引用 链接 尾');
  });

  test('识别像 Markdown 的文字，shell 输出与 JSON 不算', () {
    expect(looksLikeMarkdown('# 标题\n正文'), isTrue);
    expect(looksLikeMarkdown('说明：**重要**'), isTrue);
    expect(looksLikeMarkdown('- a\n- b'), isTrue);
    expect(looksLikeMarkdown('exit 0\ntotal 12\ndrwxr-xr-x 2 u u 4096 .'), isFalse);
    expect(looksLikeMarkdown('{"command":"ls -la"}'), isFalse);
  });
}
