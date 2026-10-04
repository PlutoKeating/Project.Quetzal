// 安装器：下发给 Termux 的命令、进度回报的解析、本机 HTTP 服务的路由。
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/installer.dart';

void main() {
  test('下发的命令：先取回脚本再执行，端口与镜像参数透传', () {
    expect(Installer.command(4567), 'curl -fsS http://127.0.0.1:4567/install.sh -o "\$PREFIX/tmp/quetzal-install.sh" && bash "\$PREFIX/tmp/quetzal-install.sh" 4567');
    expect(Installer.command(4567, cnMirror: true), endsWith(' 4567 cn'));
  });

  test('进度回报的解析', () {
    final p = Progress.fromJson({'step': 'pkg'});
    expect(p.step, 'pkg'); expect(p.done, false); expect(p.error, null);
    final d = Progress.fromJson({'done': true, 'version': '0.2.0', 'port': 7788, 'token': 't'});
    expect(d.done, true); expect(d.port, 7788); expect(d.token, 't'); expect(d.version, '0.2.0');
    final e = Progress.fromJson({'error': '安装软件包失败', 'log': 'E: ...'});
    expect(e.error, '安装软件包失败'); expect(e.log, 'E: ...');
    expect(installSteps.keys, ['pkg', 'runtime', 'service', 'config', 'start', 'health']);
  });

  test('本机 HTTP 服务：ping 与 progress 改变状态，未知路径 404', () async {
    final ins = Installer();
    await ins.start();
    expect(ins.port, greaterThan(0));
    final c = HttpClient();
    Future<HttpClientResponse> post(String path, [String body = '']) async {
      final r = await c.postUrl(Uri.parse('http://127.0.0.1:${ins.port}$path'));
      r.write(body);
      return r.close();
    }
    expect((await post('/ping')).statusCode, 200);
    expect(ins.pinged, true);
    await post('/progress', jsonEncode({'step': 'pkg'}));
    await post('/progress', jsonEncode({'step': 'runtime'}));
    expect(ins.reached, ['pkg', 'runtime']);
    await post('/progress', jsonEncode({'error': 'x', 'log': 'l'}));
    expect(ins.error, 'x'); expect(ins.running, false);
    final r = await (await c.getUrl(Uri.parse('http://127.0.0.1:${ins.port}/nothing'))).close();
    expect(r.statusCode, 404);
    final bad = await (await c.getUrl(Uri.parse('http://127.0.0.1:${ins.port}/runtime/../x'))).close();
    expect(bad.statusCode, anyOf(404, 500));
    c.close(force: true);
    ins.dispose();
  });
}
