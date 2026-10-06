// App 自身的更新：版本号比较、从 GitHub Release 挑安装包、SHA256SUMS 解析、下载与校验。
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart' as cg;
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

  test('从 releases/latest 挑出 arm64 的 APK、SHA256SUMS 与签名，标签去掉 v；只收白名单名字与 https 地址', () {
    final r = AppRelease.fromJson({
      'tag_name': 'v0.7.0', 'html_url': 'https://github.com/x/y/releases/tag/v0.7.0',
      'assets': [
        {'name': 'SHA256SUMS', 'browser_download_url': 'https://dl/SHA256SUMS', 'size': 200},
        {'name': 'SHA256SUMS.sig', 'browser_download_url': 'https://dl/SHA256SUMS.sig', 'github_download_url': 'https://gh/SHA256SUMS.sig'},
        {'name': 'quetzal-0.7.0-linux-x64-console.tar.gz', 'browser_download_url': 'https://dl/linux', 'size': 1},
        {'name': 'quetzal-0.7.0-android-arm64.apk', 'browser_download_url': 'https://dl/apk', 'size': 44040192},
      ],
    });
    expect(r.version, '0.7.0'); expect(r.tag, 'v0.7.0');
    expect(r.apkName, 'quetzal-0.7.0-android-arm64.apk'); expect(r.apkUrl, 'https://dl/apk');
    expect(r.sumsUrl, 'https://dl/SHA256SUMS'); expect(r.sigUrl, 'https://dl/SHA256SUMS.sig'); expect(r.sigUrlFallback, 'https://gh/SHA256SUMS.sig');
    expect(r.sizeText, '42.0 MB');
    final none = AppRelease.fromJson({'tag_name': 'v0.7.0', 'assets': []});
    expect(none.apkUrl, null); expect(none.sigUrl, null); expect(none.sizeText, '');
    // 名字不合白名单（带路径、别的架构、随便的 apk）一律不挑；http 地址不收
    for (final n in ['../quetzal-0.7.0-android-arm64.apk', 'quetzal-0.7.0-android-x64.apk', 'evil.apk', 'quetzal-0.7.0-android-arm64.apk.exe']) {
      expect(AppRelease.fromJson({'tag_name': 'v1', 'assets': [{'name': n, 'browser_download_url': 'https://dl/x'}]}).apkName, null, reason: n);
    }
    expect(AppRelease.fromJson({'tag_name': 'v1', 'assets': [{'name': 'quetzal-1-android-arm64.apk', 'browser_download_url': 'http://dl/x'}]}).apkUrl, null);
  });

  test('SHA256SUMS 的解析（sha256sum 格式）与 commit 行', () {
    final h = 'a' * 64, c = '0123456789abcdef0123456789abcdef01234567';
    final text = '$h  quetzal-0.7.0-android-arm64.apk\n${'B' * 64} *quetzal-0.7.0-linux-x64-console.tar.gz\nbad line\ncommit $c v0.7.0\n';
    final m = parseSums(text);
    expect(m['quetzal-0.7.0-android-arm64.apk'], h);
    expect(m['quetzal-0.7.0-linux-x64-console.tar.gz'], 'b' * 64);
    expect(m.length, 2);
    expect(parseReleaseCommit(text)?.commit, c); expect(parseReleaseCommit(text)?.tag, 'v0.7.0');
    expect(parseReleaseCommit('$h  x\n'), null);
  });

  test('签名核对：内置公钥格式正确；用测试密钥签的 SHA256SUMS 通过，改一个字节、换密钥、坏签名都拒绝', () async {
    expect(base64Url.decode('$releasePublicKey=').length, 32);
    final algo = cg.Ed25519();
    final kp = await algo.newKeyPair();
    final pub = base64Url.encode((await kp.extractPublicKey()).bytes).replaceAll('=', '');
    final apk = 'quetzal-0.7.0-android-arm64.apk', h = 'c' * 64;
    final sums = utf8.encode('$h  $apk\ncommit ${'1' * 40} v0.7.0\n');
    final sig = base64.encode((await algo.sign(sums, keyPair: kp)).bytes);
    expect(await verifySumsSignature(sums, '$sig\n', publicKey: pub), true);
    expect(await verifiedHash(sums, sig, apk, tag: 'v0.7.0', publicKey: pub), h);
    expect(await verifySumsSignature([...sums, 10], sig, publicKey: pub), false);
    expect(await verifySumsSignature(sums, sig), false); // 不是发布私钥签的
    expect(await verifySumsSignature(sums, 'not base64!', publicKey: pub), false);
    expect(await verifySumsSignature(sums, '', publicKey: pub), false);
    expect(() => verifiedHash(sums, sig, apk, tag: 'v0.8.0', publicKey: pub), throwsA(contains('不属于')));
    expect(() => verifiedHash(sums, sig, 'quetzal-0.7.0-other.apk', publicKey: pub), throwsA(contains('没有')));
    expect(() => verifiedHash(sums, sig, apk), throwsA(contains('签名验证不通过')));
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

  test('最新版取 GitHub 正式版与 npm 上运行基座两者中较老的一个', () {
    final list = <Map>[
      {'tag_name': 'v9.9.9', 'draft': false, 'prerelease': false},
      {'tag_name': 'v9.9.8', 'draft': false, 'prerelease': false},
      {'tag_name': 'android-runtime-abc', 'draft': false, 'prerelease': true},
      {'tag_name': 'v9.9.10-rc.1', 'draft': false, 'prerelease': true},
      {'tag_name': 'v9.9.7', 'draft': false, 'prerelease': false},
    ];
    expect(pickCappedRelease(list, '9.9.8')?['tag_name'], 'v9.9.8'); // GitHub 上线了 9.9.9，npm 还是 9.9.8
    expect(pickCappedRelease(list, '9.9.9')?['tag_name'], 'v9.9.9');
    expect(pickCappedRelease(list, '9.9.10')?['tag_name'], 'v9.9.9'); // npm 更新：取 GitHub 的
    expect(pickCappedRelease(list, null)?['tag_name'], 'v9.9.9'); // npm 读不到：不封顶
    expect(pickCappedRelease(list, '1.0.0'), isNull);
  });

  test('直连 GitHub 时按 npm 封顶；npm 读不到时不封顶', () async {
    final list = [{'tag_name': 'v1.1.10', 'draft': false, 'prerelease': false}, {'tag_name': 'v1.1.9', 'draft': false, 'prerelease': false}];
    expect((await directLatest((u) async => u == releasesListApi ? list : {'version': '1.1.9'}))['tag_name'], 'v1.1.9');
    expect((await directLatest((u) async => u == releasesListApi ? list : throw 'npm 连不上'))['tag_name'], 'v1.1.10');
  });
}