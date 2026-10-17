// 附件在正文里的位置（#4）：加入附件时在输入框光标处插入「[附件：文件名]」，发送时按真正发出的附件顺序改写成「[附件 N：文件名]」，
// 运行基座据此告诉她每个附件放在文字的哪个位置（第 N 个附件就是附件列表的第 N 项）。删掉标记不影响附件本身，没有标记的附件照常放在最后。

/// 一个附件在输入框里的标记；与已有的重名时加序号，保证每个附件的标记各不相同。
String attachMarker(String name, Iterable<String> existing) {
  final taken = existing.toSet();
  var m = '[附件：$name]';
  for (var i = 2; taken.contains(m); i++) { m = '[附件：$name ($i)]'; }
  return m;
}

/// 把标记插到光标处（没有有效光标就接在末尾）；返回新的文字与插入后光标的位置。标记前后与相邻文字之间补一个空格。
(String, int) insertMarkers(String text, int cursor, List<String> markers) {
  if (markers.isEmpty) return (text, cursor);
  final at = cursor < 0 || cursor > text.length ? text.length : cursor;
  final before = text.substring(0, at), after = text.substring(at);
  final lead = before.isEmpty || before.endsWith(' ') || before.endsWith('\n') ? '' : ' ';
  final trail = after.isEmpty || after.startsWith(' ') || after.startsWith('\n') ? '' : ' ';
  final ins = '$lead${markers.join(' ')}$trail';
  return ('$before$ins$after', before.length + ins.length);
}

/// 发送前：真正发出的附件（ready 为真）按顺序编号，标记改写成「[附件 N：文件名]」；没发出去的（上传失败）删掉它的标记。
String placeMarkers(String text, List<({String marker, String name, bool ready})> files) {
  var out = text, n = 0;
  for (final f in files) {
    final i = out.indexOf(f.marker);
    if (f.ready) n++;
    if (i < 0) continue;
    out = out.replaceRange(i, i + f.marker.length, f.ready ? '[附件 $n：${f.name}]' : '');
  }
  return out;
}

/// 发送时改写好的标记。
final placedMarker = RegExp(r'\[附件 \d+：[^\]\n]*\]');

/// 删掉一个附件时，把它的标记从输入框里去掉（连同多出来的一个空格）。
String removeMarker(String text, String marker) {
  final i = text.indexOf(marker);
  if (i < 0) return text;
  var end = i + marker.length;
  if (end < text.length && text[end] == ' ' && (i == 0 || text[i - 1] == ' ' || text[i - 1] == '\n')) end++;
  return text.replaceRange(i, end, '');
}
