// 桌面版的耳朵：音频整形（任意格式 → 16 kHz 单声道 20 ms 帧）、断句（迟滞、前置缓冲、单段上限）、libfvad、流式送到 /hear、她说话时不送。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/ear/pcm.dart';
import 'package:quetzal_console/ear/segmenter.dart';
import 'package:quetzal_console/platform/ear_io.dart';
import 'package:quetzal_console/platform/fvad.dart';

Uint8List s16(List<int> samples) {
  final b = ByteData(samples.length * 2);
  for (var i = 0; i < samples.length; i++) { b.setInt16(i * 2, samples[i], Endian.little); }
  return b.buffer.asUint8List();
}

/// 把字节随机切成小块（块边界可能落在一个采样中间）。
List<Uint8List> chop(Uint8List all, Random r) {
  final out = <Uint8List>[];
  var i = 0;
  while (i < all.length) { final n = min(1 + r.nextInt(999), all.length - i); out.add(Uint8List.sublistView(all, i, i + n)); i += n; }
  return out;
}

class FakeMic implements MicSource {
  final ctl = StreamController<List<int>>();
  bool stopped = false;
  @override
  Future<Stream<List<int>>> start(void Function(int, int) onFormat) async => ctl.stream;
  @override
  Future<void> stop() async { stopped = true; }
}

class FakePlayer implements VoicePlayer {
  Completer<void>? playing;
  final played = <String>[];
  @override
  Future<void> play(String file) { played.add(file); return (playing = Completer<void>()).future; }
  @override
  Future<void> stop() async { if (playing?.isCompleted == false) playing!.complete(); }
}

void main() {
  group('音频整形', () {
    test('16 kHz 单声道：原样切成 320 个采样一帧，块边界落在采样中间也不错位', () {
      final r = Random(1);
      final samples = List.generate(320 * 7 + 100, (i) => (i * 37 % 2000) - 1000);
      final f = PcmFramer();
      final frames = [for (final c in chop(s16(samples), r)) ...f.add(c)];
      expect(frames, hasLength(7));
      expect(frames.expand((x) => x).toList(), samples.sublist(0, 320 * 7));
    });
    test('48 kHz 立体声 → 16 kHz 单声道：一秒还是一秒，左右声道取平均', () {
      final r = Random(2);
      final inter = <int>[];
      for (var i = 0; i < 48000; i++) { inter..add(1000)..add(3000); }
      final f = PcmFramer(rate: 48000, channels: 2);
      final frames = [for (final c in chop(s16(inter), r)) ...f.add(c)];
      final out = frames.expand((x) => x).toList();
      expect(out.length, closeTo(16000, 320), reason: '只差不满一帧的尾巴');
      expect(out.every((v) => (v - 2000).abs() <= 1), isTrue);
    });
    test('采集端中途改了格式：之后按新格式处理', () {
      final f = PcmFramer();
      f.reconfigure(rate: 8000, channels: 1);
      final out = f.add(s16(List.filled(8000, 500))).expand((x) => x).toList();
      expect(out.length, closeTo(16000, 320));
      expect(out.every((v) => v == 500), isTrue);
    });
    test('帧 → 小端字节', () {
      expect(frameBytes(Int16List.fromList([1, -2, 0x1234])), [1, 0, 0xFE, 0xFF, 0x34, 0x12]);
    });
  });

  group('断句', () {
    late List<String> log;
    late int now;
    Segmenter seg() => Segmenter(
        isSpeech: (f) => f[0] != 0,
        onStart: (t) => log.add('start@$t'),
        onFrame: (f) => log.add('f'),
        onEnd: (r, ms) => log.add('end:$r:$ms'),
        now: () => now);
    Int16List v(bool voiced) => Int16List(frameSamples)..[0] = voiced ? 1000 : 0;
    setUp(() { log = []; now = 1000000; });

    test('连续 100 ms 有人声才开始（带上前 300 ms），连续 1.5 秒没人声才算说完', () {
      final s = seg();
      for (var i = 0; i < 20; i++) { s.feed(v(false)); }
      for (var i = 0; i < 4; i++) { s.feed(v(true)); }
      expect(log, isEmpty, reason: '还不到 100 ms');
      s.feed(v(true));
      expect(log.first, 'start@${1000000 - 15 * 20}');
      expect(log.where((x) => x == 'f'), hasLength(16), reason: '前置 15 帧（含刚才那 4 帧人声）+ 这一帧');
      for (var i = 0; i < 5; i++) { s.feed(v(true)); }
      s.feed(v(false)); s.feed(v(true)); // 句中的短停顿不算结束
      for (var i = 0; i < 74; i++) { s.feed(v(false)); }
      expect(log.last, 'f', reason: '停顿还不到 1.5 秒');
      s.feed(v(false));
      expect(log.last, 'end:silence:${(16 + 5 + 2 + 74) * 20}');
      expect(log.where((x) => x.startsWith('start')), hasLength(1));
    });
    test('单段最长 120 秒：先送出去，接着开新的一句', () {
      final s = seg();
      for (var i = 0; i < 5 + Segmenter.maxFrames + 10; i++) { s.feed(v(true)); }
      expect(log.where((x) => x.startsWith('end:too-long:${Segmenter.maxFrames * 20}')), hasLength(1));
      expect(log.where((x) => x.startsWith('start')), hasLength(2));
    });
    test('她开口了（reset）：正在说的这句结束，迟滞与前置缓冲清空', () {
      final s = seg();
      for (var i = 0; i < 10; i++) { s.feed(v(true)); }
      s.reset('speaking');
      expect(log.last, startsWith('end:speaking:'));
      log.clear();
      for (var i = 0; i < 4; i++) { s.feed(v(true)); }
      expect(log, isEmpty, reason: '重新从 0 开始数');
    });
  });

  test('灵敏度 → WebRTC VAD 模式（与安卓耳朵一致）', () {
    expect([1, 2, 3, 0].map(vadMode).toList(), [3, 2, 0, 2]);
  });

  test('Linux 的采集与播放命令；临时语音文件名只要合规的', () {
    expect(linuxMicCommands().map((c) => c.$1).toList(), ['parec', 'pw-record', 'arecord']);
    for (final (_, args) in linuxMicCommands()) { expect(args.join(' '), contains('16000')); }
    expect(linuxPlayerCommands('/t/a.mp3').map((c) => c.$1).toList(), ['pw-play', 'paplay', 'ffplay', 'mpv']);
    expect(voiceFileName('http://127.0.0.1:7788/media/abc-1.mp3'), 'abc-1.mp3');
    expect(voiceFileName('http://127.0.0.1:7788/media/..%2Fx.mp3'), 'voice.mp3');
    expect(voiceFileName('http://127.0.0.1:7788/media/a.sh'), 'voice.mp3');
  });

  test('libfvad：自带的源码编得出来，静音判为没有人声，帧长不对报错', () async {
    final cc = await Process.run('sh', ['-c', 'command -v cc']);
    if (cc.exitCode != 0) { markTestSkipped('没有 C 编译器'); return; }
    final dir = Directory.systemTemp.createTempSync('fvad-');
    addTearDown(() => dir.deleteSync(recursive: true));
    final srcs = Directory('native/fvad/src').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.c')).map((f) => f.path);
    final so = '${dir.path}/libfvad.so';
    final r = await Process.run('cc', ['-shared', '-fPIC', '-O2', '-DNDEBUG', '-Inative/fvad/include', ...srcs, '-o', so]);
    expect(r.exitCode, 0, reason: '${r.stderr}');
    final v = Fvad(mode: 2, library: so);
    addTearDown(v.dispose);
    expect(v.isSpeech(Int16List(320)), isFalse);
    final noise = Random(3);
    for (var i = 0; i < 50; i++) { v.isSpeech(Int16List.fromList(List.generate(320, (_) => noise.nextInt(20000) - 10000))); } // 不崩
    expect(() => v.isSpeech(Int16List(123)), throwsStateError);
  });

  group('桌面版耳朵：流式送到 /hear', () {
    late HttpServer srv;
    late List<(Uri, List<int>, String?)> heard;
    setUp(() async {
      heard = [];
      srv = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      srv.listen((req) async {
        final body = await req.fold<List<int>>([], (a, b) => a..addAll(b));
        if (req.uri.path == '/hear') {
          heard.add((req.uri, body, req.headers.value('x-quetzal-token')));
          req.response.write(jsonEncode({'ok': true, 'id': req.uri.queryParameters['id'], 'text': '你好'}));
        } else if (req.uri.path.startsWith('/media/')) {
          if (req.headers.value('x-quetzal-token') != 'tok') { req.response.statusCode = 401; } else { req.response.add([1, 2, 3]); }
        }
        await req.response.close();
      });
    });
    tearDown(() => srv.close(force: true));

    test('一句话：started、id、令牌放请求头，PCM 边说边送；说完收到识别结果', () async {
      final mic = FakeMic();
      final ear = DesktopEar(mic: () => mic, player: FakePlayer(), detector: (s) => ((f) => f[0] != 0, () {}), now: () => 5000000);
      final events = <Map>[];
      ear.events.listen(events.add);
      await ear.start(base: 'http://127.0.0.1:${srv.port}', token: 'tok', sensitivity: 2);
      await Future<void>.delayed(Duration.zero); // 广播事件异步送达
      expect(events.first, {'kind': 'state', 'running': true});
      Int16List fr(bool voiced) => Int16List(frameSamples)..[0] = voiced ? 1000 : 0..[1] = 7;
      for (var i = 0; i < 3; i++) { mic.ctl.add(frameBytes(fr(false))); }
      for (var i = 0; i < 10; i++) { mic.ctl.add(frameBytes(fr(true))); }
      for (var i = 0; i < 80; i++) { mic.ctl.add(frameBytes(fr(false))); }
      await Future.doWhile(() async { await Future.delayed(const Duration(milliseconds: 20)); return !events.any((e) => e['kind'] == 'heard'); }).timeout(const Duration(seconds: 5));
      final (uri, body, token) = heard.single;
      expect(uri.queryParameters['stream'], '1');
      expect(uri.queryParameters['started'], '${5000000 - 7 * 20}', reason: '前置缓冲里只有 3 帧静音 + 4 帧人声');
      expect(uri.queryParameters['id'], matches(RegExp(r'^[0-9a-f]{12}$')));
      expect(token, 'tok');
      expect(body.length, (7 + 6 + 74) * frameSamples * 2);
      expect(events.firstWhere((e) => e['kind'] == 'heard')['text'], '你好');
      expect(events.where((e) => e['kind'] == 'speech').map((e) => e['on']).toList(), [true, false]);
      await ear.stop();
      await Future<void>.delayed(Duration.zero);
      expect(mic.stopped, isTrue);
      expect(events.last, {'kind': 'state', 'running': false});
    });

    test('她在说话时不送；播放她的声音：带令牌下载、放完回报 played', () async {
      final mic = FakeMic(), player = FakePlayer();
      var t = 1000;
      final ear = DesktopEar(mic: () => mic, player: player, detector: (s) => ((f) => f[0] != 0, () {}), now: () => t);
      final events = <Map>[];
      ear.events.listen(events.add);
      await ear.start(base: 'http://127.0.0.1:${srv.port}', token: 'tok', sensitivity: 2);
      ear.mutedUntil = 999999; // 运行基座推来的 speaking 窗口
      for (var i = 0; i < 40; i++) { mic.ctl.add(frameBytes(Int16List(frameSamples)..[0] = 1000)); }
      await Future.delayed(const Duration(milliseconds: 100));
      expect(events.where((e) => e['kind'] == 'speech'), isEmpty);
      expect(heard, isEmpty);
      // 本机播放：下载到临时文件，放的期间同样不送，放完回报
      ear.mutedUntil = 0;
      expect(await ear.play('v1', 'http://127.0.0.1:${srv.port}/media/v1.mp3'), isTrue);
      expect(player.played.single, endsWith('v1.mp3'));
      await Future<void>.delayed(Duration.zero);
      expect(events.where((e) => e['kind'] == 'playing').single['on'], isTrue);
      player.playing!.complete();
      await Future.delayed(const Duration(milliseconds: 50));
      expect(events.last, {'kind': 'played', 'id': 'v1', 'interrupted': false});
      expect(File(player.played.single).existsSync(), isFalse, reason: '临时文件删掉了');
      expect(await DesktopEar(mic: () => mic, player: player, detector: (s) => ((f) => false, () {})).play('v2', 'http://127.0.0.1:${srv.port}/media/v2.mp3'), isFalse, reason: '没有令牌');
      await ear.stop();
    });
  });
}
