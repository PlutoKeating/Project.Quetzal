import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/platform/tray_io.dart';

void main() {
  test('桌面控制台换了新版本：自己的可执行文件被删了、或 current 指到了别的版本，就是旧的', () {
    final root = Directory.systemTemp.createTempSync('qc-');
    addTearDown(() => root.deleteSync(recursive: true));
    for (final v in ['1.1.13', '1.2.0']) { File('${root.path}/$v/quetzal-console').createSync(recursive: true); }
    Link('${root.path}/current').createSync('${root.path}/1.1.13');
    expect(staleExecutable('${root.path}/1.1.13/quetzal-console'), isFalse, reason: 'current 就是自己');
    Link('${root.path}/current').updateSync('${root.path}/1.2.0');
    expect(staleExecutable('${root.path}/1.1.13/quetzal-console'), isTrue, reason: 'current 换到了新版本');
    expect(staleExecutable('${root.path}/1.2.0/quetzal-console'), isFalse);
    expect(staleExecutable('${root.path}/1.1.13/quetzal-console (deleted)'), isTrue, reason: '旧目录已被安装脚本删掉');
    expect(staleExecutable('/usr/bin/quetzal-console'), isFalse, reason: '不是安装脚本的目录布局');
  });
}
