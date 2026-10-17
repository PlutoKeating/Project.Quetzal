// 轻量的代码高亮（Canvas 的代码编辑）：按语言用几条正则切出注释、字符串、数字、关键字，其余照原样。
//   不引入重型编辑器（CodeMirror / Monaco 要嵌网页引擎、或几十万行的 Dart 包）：Canvas 里的代码多是几十到几百行的脚本，
//   这种程度的着色已经够看清结构；太长的内容（超过 60000 字符）不着色，免得每次按键都重新切一遍。
import 'package:flutter/material.dart';

const _kw = {
  'python': 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self print',
  'javascript': 'async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null of return super switch this throw true try typeof undefined var void while with yield require console',
  'typescript': 'abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends false finally for from function if implements import in interface instanceof keyof let module namespace never new null number of private protected public readonly return string super switch this throw true try type typeof undefined unknown var void while yield console',
  'shell': 'if then else elif fi for while until do done case esac in function return local export echo exit set unset readonly shift cd test true false',
  'powershell': 'begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while Write-Host Write-Output Get-ChildItem Set-Location',
  'dart': 'abstract as async await break case catch class const continue default do else enum extends false final finally for if import in is late new null return static super switch this throw true try var void while with yield',
  'go': 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  'rust': 'as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
  'java': 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void while',
  'c': 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define',
  'sql': 'select from where insert into values update set delete create table drop alter join left right inner outer on group by order having limit as and or not null is in like distinct',
};

/// 各类记号的颜色（跟着亮 / 暗主题）。
class CodePalette {
  final Color comment, string, number, keyword;
  const CodePalette({required this.comment, required this.string, required this.number, required this.keyword});
  factory CodePalette.of(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return dark
        ? const CodePalette(comment: Color(0xFF7F8C8D), string: Color(0xFF98C379), number: Color(0xFFD19A66), keyword: Color(0xFFC678DD))
        : const CodePalette(comment: Color(0xFF8A8F98), string: Color(0xFF2E7D32), number: Color(0xFFB45309), keyword: Color(0xFF7B1FA2));
  }
}

String _family(String lang) => switch (lang) {
      'python' || 'shell' || 'powershell' || 'yaml' || 'toml' || 'r' || 'ruby' || 'perl' => 'hash',
      'sql' => 'sql',
      _ => 'c',
    };

/// 一种语言的记号正则：1 注释、2 字符串、3 数字、4 词。
RegExp _pattern(String lang) {
  final family = _family(lang);
  final comment = switch (family) { 'hash' => r'#[^\n]*', 'sql' => r'--[^\n]*|/\*[\s\S]*?(?:\*/|$)', _ => r'//[^\n]*|/\*[\s\S]*?(?:\*/|$)' };
  final strings = lang == 'python'
      ? r'"""[\s\S]*?(?:"""|$)|' "'''" r"[\s\S]*?(?:'''|$)|" r'"(?:\\.|[^"\\\n])*"?|' r"'(?:\\.|[^'\\\n])*'?"
      : r'"(?:\\.|[^"\\\n])*"?|' r"'(?:\\.|[^'\\\n])*'?|" r'`(?:\\.|[^`\\])*`?';
  return RegExp('($comment)|($strings)|(\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b|\\b0[xX][0-9a-fA-F]+\\b)|([A-Za-z_\$][\\w\$-]*)');
}

/// 把 code 切成着色的片段（拼起来与原文逐字相同）。
List<TextSpan> highlight(String code, String lang, CodePalette p, {TextStyle? base}) {
  if (code.length > 60000 || lang.isEmpty || lang == 'markdown' || lang == 'text') return [TextSpan(text: code, style: base)];
  final words = (_kw[lang] ?? _kw[_family(lang) == 'hash' ? 'shell' : 'javascript']!).split(' ').toSet();
  final caseless = lang == 'sql' || lang == 'powershell';
  final lower = caseless ? words.map((w) => w.toLowerCase()).toSet() : words;
  final out = <TextSpan>[];
  var at = 0;
  for (final m in _pattern(lang).allMatches(code)) {
    if (m.start > at) out.add(TextSpan(text: code.substring(at, m.start), style: base));
    final t = m.group(0)!;
    final style = m.group(1) != null ? TextStyle(color: p.comment, fontStyle: FontStyle.italic)
        : m.group(2) != null ? TextStyle(color: p.string)
        : m.group(3) != null ? TextStyle(color: p.number)
        : (caseless ? lower.contains(t.toLowerCase()) : words.contains(t)) ? TextStyle(color: p.keyword, fontWeight: FontWeight.w600)
        : null;
    out.add(TextSpan(text: t, style: style == null ? base : (base ?? const TextStyle()).merge(style)));
    at = m.end;
  }
  if (at < code.length) out.add(TextSpan(text: code.substring(at), style: base));
  return out;
}

/// 带高亮的输入框控制器：输入法正在组字时不着色（组字区要照原样画下划线）。
class CodeController extends TextEditingController {
  String lang;
  CodeController({super.text, this.lang = ''});
  @override
  TextSpan buildTextSpan({required BuildContext context, TextStyle? style, required bool withComposing}) {
    if (lang.isEmpty || (withComposing && value.isComposingRangeValid)) return super.buildTextSpan(context: context, style: style, withComposing: withComposing);
    return TextSpan(style: style, children: highlight(text, lang, CodePalette.of(context)));
  }
}
