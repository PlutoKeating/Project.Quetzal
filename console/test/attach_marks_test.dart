// 附件在正文里的位置标记（#4）。
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/attach_marks.dart';

void main() {
  test('重名的附件各有各的标记', () {
    expect(attachMarker('a.png', []), '[附件：a.png]');
    expect(attachMarker('a.png', ['[附件：a.png]']), '[附件：a.png (2)]');
    expect(attachMarker('a.png', ['[附件：a.png]', '[附件：a.png (2)]']), '[附件：a.png (3)]');
  });

  test('插在光标处，和相邻文字隔一个空格；没有光标接在末尾', () {
    expect(insertMarkers('看这张图哪里不对', 4, ['[附件：a.png]']), ('看这张图 [附件：a.png] 哪里不对', 16));
    expect(insertMarkers('第一张', -1, ['[附件：a.png]', '[附件：b.png]']), ('第一张 [附件：a.png] [附件：b.png]', 25));
    expect(insertMarkers('', 0, ['[附件：a.png]']), ('[附件：a.png]', 10));
  });

  test('发送时按真正发出的附件编号；上传失败的删掉标记', () {
    final files = [(marker: '[附件：a.png]', name: 'a.png', ready: true), (marker: '[附件：坏.pdf]', name: '坏.pdf', ready: false), (marker: '[附件：c.txt]', name: 'c.txt', ready: true)];
    expect(placeMarkers('先看 [附件：c.txt] 再对照 [附件：a.png]，还有 [附件：坏.pdf]', files), '先看 [附件 2：c.txt] 再对照 [附件 1：a.png]，还有 ');
    expect(placedMarker.hasMatch('[附件 2：c.txt]'), isTrue);
  });

  test('删掉附件时去掉它的标记', () {
    expect(removeMarker('看 [附件：a.png] 这里', '[附件：a.png]'), '看 这里');
    expect(removeMarker('没有标记', '[附件：a.png]'), '没有标记');
  });
}
