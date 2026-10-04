// App 自身的更新：版本号比较、从 GitHub Release 挑安装包、SHA256SUMS 解析、下载与校验。
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/updater.dart';

void main() {
  test('版本号比较：逐段比数字，预览版比同号正式版旧', () {
    expect(compareVersions('0.6.1', '0.6.1'), 0);
    expect(compareVersions('0.6.2', '0.6.1'), greaterThan(0));
    expect(compareVersions('0.7.0', '0.6.10'), greaterThan(0));
    expect(compareVersions('0.6.10', '0.6.9'), greaterThan(0));
    expect(compareVersions('1.0', '1.0.0'), 0);
    expect(compareVersions('0.7.0-beta.1', '0.7.0'), lessThan(0));
    expect(compareVersions('0.7.0-beta.1', '0.6.1'), greaterThan(0));
  });

  test('从 releases/latest 挑出 arm64 的 APK 与 SHA256SUMS，标签去掉 v', () {
    final r = AppRelease.fromJson({
      'tag_name': 'v0.7.0', 'html_url': 'https://github.com/x/y/releases/tag/v0.7.0',
      'assets': [
        {'name': 'SHA256SUMS', 'browser_download_url': 'https://dl/SHA256SUMS', 'size': 200},
        {'name': 'quetzal-0.7.0-linux-x64-console.tar.gz', 'browser_download_url': 'https://dl/linux', 'size': 1},
        {'name': 'quetzal-0.7.0-android-arm64.apk', 'browser_download_url': 'https://dl/apk', 'size': 44040192},
      ],
    });
    expect(r.version, '0.7.0'); expect(r.tag, 'v0.7.0');
    expect(r.apkName, 'quetzal-0.7.0-android-arm64.apk'); expect(r.apkUrl, 'https://dl/apk');
    expect(r.sumsUrl, 'https://dl/SHA256SUMS'); expect(r.sizeText, '42.0 MB');
    final none = AppRelease.fromJson({'tag_name': 'v0.7.0', 'assets': []});
    expect(none.apkUrl, null); expect(none.sizeText, '');
  });

  test('SHA256SUMS 的解析（sha256sum 格式）', () {
    final h = 'a' * 64;
    final m = parseSums('$h  quetzal-0.7.0-android-arm64.apk\n${'B' * 64} *SHA256SUMS-other\nbad line\n');
    expect(m['quetzal-0.7.0-android-arm64.apk'], h);
    expect(m['SHA256SUMS-other'], 'b' * 64);
    expect(m.length, 2);
  });

  test('下载：写到文件、报进度、返回 SHA256；非 200 报错', () async {
    final body = List<int>.generate(100000, (i) => i % 251);
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      if (req.uri.path == '/apk') { req.response.contentLength = body.length; req.response.add(body); }
      else if (req.uri.path == '/go') { req.response.redirect(Uri.parse('http://127.0.0.1:${server.port}/apk')); return; }
      else { req.response.statusCode = 404; }
      await req.response.close();
    });
    final dir = await Directory.systemTemp.createTemp('quetzal-updater-test');
    try {
      final f = File('${dir.path}/sub/a.apk');
      final seen = <double>[];
      final sha = await AppUpdater.download(Uri.parse('http://127.0.0.1:${server.port}/go'), f, onProgress: (g, t) => seen.add(g / t));
      expect(await f.readAsBytes(), body);
      expect(sha, sha256.convert(body).toString());
      expect(seen.last, 1.0);
      expect(() => AppUpdater.download(Uri.parse('http://127.0.0.1:${server.port}/missing'), File('${dir.path}/b')), throwsA(contains('404')));
      final j = await AppUpdater.fetchBytes(Uri.parse('http://127.0.0.1:${server.port}/apk'));
      expect(j.length, body.length);
    } finally { await server.close(force: true); await dir.delete(recursive: true); }
  });

  test('解析 JSON 接口：非对象报错', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async { req.response.write(jsonEncode(req.uri.path == '/obj' ? {'tag_name': 'v1'} : [1])); await req.response.close(); });
    try {
      expect((await AppUpdater.fetchJson(Uri.parse('http://127.0.0.1:${server.port}/obj')))['tag_name'], 'v1');
      expect(() => AppUpdater.fetchJson(Uri.parse('http://127.0.0.1:${server.port}/arr')), throwsA(anything));
    } finally { await server.close(force: true); }
  });
}
