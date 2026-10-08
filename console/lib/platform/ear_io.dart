// 桌面版（Linux / Windows）的耳朵：在控制台进程里做安卓 HearingService 做的事（参数一致），由 hearing.dart 按运行基座的意愿启停——
//   采集：Linux 用系统自带的 parec / pw-record / arecord（按顺序探测，与运行基座的 Linux 适配器同一思路，不多装原生依赖），
//         Windows 用 record_windows（Media Foundation）；都要 16 kHz 单声道 16 位 PCM，设备给的格式不同时由 PcmFramer 转换。
//   断句：libfvad（WebRTC VAD，与安卓 android-vad 同一算法）+ Segmenter（迟滞、前置 300 ms、单段 120 秒）。
//   投递：一句话开始就打开到本机网关 /hear?stream=1&started=…&id=… 的分块 POST，边说边送，令牌放请求头；说完关闭请求体、等识别结果。
//   播放：登记为她的播放器后，speak 事件的语音由这里下载（/media/…，令牌放请求头）到临时文件再播放——
//         Linux 用 pw-play / paplay / ffplay / mpv（与适配器相同的候选），Windows 用系统的 winmm（MCI，能放 mp3）。
//   回声：桌面上拿不到可靠的系统回声消除（PulseAudio 的 echo-cancel 要手动加载、PipeWire 要另配，Windows 的通信处理只对通话应用生效），
//         所以如实降级：她说话时（本机在放她的声音、或运行基座推来的 speaking 窗口之内，再加 300 ms 余音）耳朵不断句、不送音频，
//         正在说的那句话就此结束送出；不做插嘴（播放不会被对方打断，player.done 的 interrupted 恒为假）。
import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart' show debugPrint, visibleForTesting;
import 'package:record_platform_interface/record_platform_interface.dart';
import '../ear/pcm.dart';
import '../ear/segmenter.dart';
import 'fvad.dart';

/// 一个能流式给出 PCM 的麦克风。onFormat：实际的采样率与声道数（和请求的 16 kHz 单声道不同时回报）。
abstract class MicSource {
  Future<Stream<List<int>>> start(void Function(int rate, int channels) onFormat);
  Future<void> stop();
}

/// 播放一个本地音频文件，放完（或被 stop）才返回。
abstract class VoicePlayer {
  Future<void> play(String file);
  Future<void> stop();
}

/// 断句用的人声判断：返回判断函数与释放函数。
typedef DetectorFactory = (bool Function(Int16List), void Function()) Function(int sensitivity);

/// PATH 里有没有这个程序。
String? which(String name) {
  final sep = Platform.isWindows ? ';' : ':';
  for (final d in (Platform.environment['PATH'] ?? '').split(sep)) {
    if (d.isEmpty) continue;
    final f = File('$d${Platform.pathSeparator}$name');
    if (f.existsSync()) return f.path;
  }
  return null;
}

/// Linux 的采集命令（按顺序试）：都输出 16 kHz 单声道 s16le 裸 PCM 到标准输出。
@visibleForTesting
List<(String, List<String>)> linuxMicCommands() => const [
  ('parec', ['--raw', '--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=40', '--client-name=Quetzal']),
  ('pw-record', ['--raw', '--rate', '16000', '--channels', '1', '--format', 's16', '-']),
  ('arecord', ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', '16000', '-c', '1']),
];

/// Linux 的播放命令（按顺序试，与运行基座 Linux 适配器的候选一致）。
@visibleForTesting
List<(String, List<String>)> linuxPlayerCommands(String file) => [
  ('pw-play', [file]),
  ('paplay', [file]),
  ('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', file]),
  ('mpv', ['--no-video', '--really-quiet', file]),
];

/// /media/<文件名> 的本地文件名：只要合规的名字（与网关的 mediaFile 规则一致），否则用 voice.mp3。
@visibleForTesting
String voiceFileName(String url) {
  final segs = Uri.tryParse(url)?.pathSegments ?? const [];
  final n = segs.isEmpty ? '' : segs.last;
  return RegExp(r'^[A-Za-z0-9._-]{1,120}\.(mp3|wav|ogg|webm)$', caseSensitive: false).hasMatch(n) ? n : 'voice.mp3';
}

class _CliMic implements MicSource {
  Process? _p;
  @override
  Future<Stream<List<int>>> start(void Function(int, int) onFormat) async {
    final tried = <String>[];
    for (final (cmd, args) in linuxMicCommands()) {
      if (which(cmd) == null) continue;
      tried.add(cmd);
      final p = await Process.start(cmd, args);
      final early = await p.exitCode.timeout(const Duration(milliseconds: 600), onTimeout: () => -1 << 20);
      if (early != -1 << 20) { await p.stderr.drain<void>().catchError((_) {}); continue; } // 一开始就退出了（没有这个音频服务）：换下一个
      _p = p;
      p.stderr.listen((_) {}, onError: (_) {});
      return p.stdout;
    }
    throw StateError(tried.isEmpty ? '录音需要 parec、pw-record 或 arecord 之一' : '麦克风打不开（试过 ${tried.join('、')}）');
  }

  @override
  Future<void> stop() async { _p?.kill(); _p = null; }
}

class _RecordMic implements MicSource {
  static const _id = 'quetzal-ear';
  bool _created = false;
  RecordPlatform get _r => RecordPlatform.instance;

  @override
  Future<Stream<List<int>>> start(void Function(int, int) onFormat) async {
    await _r.create(_id);
    _created = true;
    if (!await _r.hasPermission(_id, request: true)) throw StateError('没有麦克风权限（设置 › 隐私和安全性 › 麦克风 › 允许桌面应用访问）');
    _r.setOnConfigChanged(_id, (c) => onFormat(c.sampleRate, c.numChannels));
    return _r.startStream(_id, const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: earRate, numChannels: 1, autoGain: true, noiseSuppress: true));
  }

  @override
  Future<void> stop() async {
    if (!_created) return;
    _created = false;
    try { _r.setOnConfigChanged(_id, null); await _r.stop(_id); } catch (_) {}
    try { await _r.dispose(_id); } catch (_) {}
  }
}

class _CliPlayer implements VoicePlayer {
  Process? _p;
  bool _stopped = false;
  @override
  Future<void> play(String file) async {
    _stopped = false;
    for (final (cmd, args) in linuxPlayerCommands(file)) {
      if (_stopped) return;
      if (which(cmd) == null) continue;
      final started = DateTime.now();
      final p = _p = await Process.start(cmd, args);
      p.stdout.listen((_) {}, onError: (_) {});
      p.stderr.listen((_) {}, onError: (_) {});
      final code = await p.exitCode;
      _p = null;
      // 放不了这种格式（例如老的 libsndfile 不认 mp3）会立刻失败：换下一个播放器
      if (code == 0 || _stopped || DateTime.now().difference(started) > const Duration(milliseconds: 1500)) return;
    }
    if (!_stopped) throw StateError('没有能用的播放器（pw-play、paplay、ffplay 或 mpv）');
  }

  @override
  Future<void> stop() async { _stopped = true; _p?.kill(); _p = null; }
}

/// Windows：winmm 的 MCI 字符串命令（系统自带，经 DirectShow 能放 mp3 / wav）。不阻塞：开始播放后每 200 ms 问一次状态。
class _MciPlayer implements VoicePlayer {
  static const _alias = 'quetzal_voice';
  static int Function(Pointer<Utf16>, Pointer<Utf16>, int, int)? _fn;
  Completer<void>? _done;
  Timer? _poll;

  static String? _send(String cmd) {
    final fn = _fn ??= DynamicLibrary.open('winmm.dll')
        .lookupFunction<Uint32 Function(Pointer<Utf16>, Pointer<Utf16>, Uint32, IntPtr), int Function(Pointer<Utf16>, Pointer<Utf16>, int, int)>('mciSendStringW');
    final c = cmd.toNativeUtf16(allocator: calloc);
    final r = calloc<Uint16>(128).cast<Utf16>();
    try { return fn(c, r, 128, 0) == 0 ? r.toDartString() : null; } finally { calloc.free(c); calloc.free(r); }
  }

  @override
  Future<void> play(String file) async {
    await stop();
    _send('close $_alias');
    if (_send('open "${file.replaceAll('"', '')}" type mpegvideo alias $_alias') == null) throw StateError('系统放不了这段声音');
    if (_send('play $_alias') == null) { _send('close $_alias'); throw StateError('系统放不了这段声音'); }
    final done = _done = Completer<void>();
    _poll = Timer.periodic(const Duration(milliseconds: 200), (_) {
      final mode = _send('status $_alias mode');
      if (mode == 'playing' || mode == 'seeking') return;
      _finish();
    });
    return done.future;
  }

  void _finish() {
    _poll?.cancel(); _poll = null;
    _send('close $_alias');
    final d = _done;
    _done = null;
    if (d != null && !d.isCompleted) d.complete();
  }

  @override
  Future<void> stop() async { if (_done != null) _finish(); }
}

/// 一句话的流式上传：/hear?stream=1，分块传输，令牌放请求头。
class _Upload {
  final _body = StreamController<List<int>>();
  int sent = 0;
  _Upload(String url, String token, void Function(int status, String body, int sent) done, void Function(Object e) failed) {
    () async {
      final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
      try {
        final req = await c.postUrl(Uri.parse(url));
        req.headers.set('X-Quetzal-Token', token);
        req.headers.set('x-token', token);
        req.headers.contentType = ContentType.binary;
        req.bufferOutput = false; // 每帧（20 ms）到了就发
        await req.addStream(_body.stream.map((b) { sent += b.length; return b; }));
        final res = await req.close().timeout(const Duration(seconds: 60));
        // 基座识别期间每 10 秒发一个空白：60 秒内没收到任何字节才算没有回应（还在识别的长句不会被砍掉）
        done(res.statusCode, await res.timeout(const Duration(seconds: 60)).transform(utf8.decoder).join(), sent);
      } catch (e) {
        _dead = true;
        if (!_body.hasListener) _body.stream.listen((_) {}); // 连不上：后面的帧不再攒着
        failed(e);
      } finally {
        c.close(force: true);
      }
    }();
  }
  bool _dead = false;
  void add(List<int> b) { if (!_dead && !_body.isClosed) _body.add(b); }
  Future<void> close() => _body.close();
}

class DesktopEar {
  static final instance = DesktopEar();
  static bool get supported => Platform.isLinux || Platform.isWindows;

  final MicSource Function() _mic;
  final VoicePlayer _player;
  final DetectorFactory _detector;
  final int Function() _now;

  DesktopEar({MicSource Function()? mic, VoicePlayer? player, DetectorFactory? detector, int Function()? now})
      : _mic = mic ?? (() => Platform.isWindows ? _RecordMic() : _CliMic()),
        _player = player ?? (Platform.isWindows ? _MciPlayer() : _CliPlayer()),
        _detector = detector ?? ((s) { final f = Fvad(mode: vadMode(s)); return (f.isSpeech, f.dispose); }),
        _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);

  final _events = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get events => _events.stream;
  void _emit(Map<String, dynamic> e) { if (!_events.isClosed) _events.add(e); }

  bool _running = false;
  bool get running => _running;
  /// 她在说话到这个时刻（毫秒；来自运行基座的 speaking 事件）：之前耳朵不断句、不送。
  int mutedUntil = 0;

  String _base = '', _token = '';
  MicSource? _src;
  StreamSubscription<List<int>>? _sub;
  void Function()? _release;
  PcmFramer? _framer;
  Segmenter? _seg;
  _Upload? _up;
  bool _wasMuted = false;

  // 播放
  bool _playing = false;
  String? _playingId;
  int _playGen = 0, _playEndedAt = 0;

  bool get _muted => _playing || _now() < mutedUntil || _now() < _playEndedAt + 300;

  /// 开耳朵（已开着就按新参数重开）。打不开麦克风或断句库时抛出。
  Future<void> start({required String base, required String token, required int sensitivity}) async {
    await stop();
    _base = base; _token = token;
    final (isSpeech, release) = _detector(sensitivity);
    _release = release;
    final framer = _framer = PcmFramer();
    _seg = Segmenter(isSpeech: isSpeech, onStart: _onStart, onFrame: _onFrame, onEnd: _onEnd, now: _now);
    final src = _src = _mic();
    try {
      final stream = await src.start((rate, ch) => framer.reconfigure(rate: rate, channels: ch));
      _sub = stream.listen(_onPcm, onError: (Object e) => _fail('麦克风出错：$e'), onDone: () { if (_running) _fail('麦克风停了'); });
    } catch (e) {
      await _teardown();
      rethrow;
    }
    _running = true;
    _emit({'kind': 'state', 'running': true});
  }

  Future<void> stop() async {
    final was = _running;
    _running = false;
    _seg?.reset('stop');
    await _teardown();
    if (was) _emit({'kind': 'state', 'running': false});
  }

  Future<void> _teardown() async {
    await _sub?.cancel(); _sub = null;
    await _src?.stop(); _src = null;
    _release?.call(); _release = null;
    _seg = null; _framer = null;
  }

  void _fail(String why) {
    _emit({'kind': 'error', 'message': why});
    unawaited(stop());
  }

  void _onPcm(List<int> bytes) {
    final framer = _framer, seg = _seg;
    if (framer == null || seg == null) return;
    for (final f in framer.add(bytes)) {
      if (_muted) {
        if (!_wasMuted) seg.reset('speaking'); // 她开口了：正在说的那句话就此结束送出，余下的声音多半是她自己
        _wasMuted = true;
        continue;
      }
      _wasMuted = false;
      try { seg.feed(f); } catch (e) { _fail('断句出错：$e'); return; }
    }
  }

  static String _uid() { final r = Random.secure(); return List.generate(12, (_) => r.nextInt(16).toRadixString(16)).join(); }

  void _onStart(int startedAt) {
    final id = _uid();
    _up = _Upload('$_base/hear?stream=1&started=$startedAt&id=$id', _token, (status, body, sent) {
      if (status >= 400) { _emit({'kind': 'error', 'message': '基座拒绝了这句话（HTTP $status）'}); return; }
      Map j = const {};
      try { j = jsonDecode(body) as Map; } catch (_) {}
      if (j['ok'] == false) { _emit({'kind': 'error', 'message': '基座没能处理这句话：${j['message'] ?? ''}'}); return; }
      _emit({'kind': 'heard', 'text': '${j['text'] ?? ''}', 'dropped': j['dropped'], 'ms': sent ~/ 32});
    }, (e) => _emit({'kind': 'error', 'message': '送到基座失败：$e'}));
    _emit({'kind': 'speech', 'on': true});
  }

  void _onFrame(Int16List f) => _up?.add(frameBytes(f));

  void _onEnd(String reason, int ms) {
    _emit({'kind': 'speech', 'on': false, 'ms': ms, 'reason': reason});
    unawaited(_up?.close());
    _up = null;
  }

  /// 下载并播放她的一段声音（[url] 为网关上的 /media/…）；下载失败返回 false。放完以 played 事件回报。
  Future<bool> play(String id, String url) async {
    await stopPlayback();
    final gen = ++_playGen;
    File file;
    try {
      file = await _download(url);
    } catch (e) {
      _emit({'kind': 'error', 'message': '取她的声音失败：$e'});
      return false;
    }
    if (gen != _playGen) { _delete(file); return false; }
    _playing = true; _playingId = id;
    _seg?.reset('speaking');
    _emit({'kind': 'playing', 'on': true});
    unawaited(() async {
      try { await _player.play(file.path); } catch (e) { _emit({'kind': 'error', 'message': '$e'}); }
      _delete(file);
      if (gen != _playGen) return; // 已被新的一段或 stopPlayback 接手（那边已经回报过）
      _endPlayback();
    }());
    return true;
  }

  void _endPlayback() {
    final id = _playingId;
    _playing = false; _playingId = null; _playEndedAt = _now();
    _emit({'kind': 'playing', 'on': false});
    if (id != null) _emit({'kind': 'played', 'id': id, 'interrupted': false});
  }

  /// 停止播放（新的一段来了、或耳朵关了）：回报这一段已结束。
  Future<void> stopPlayback() async {
    _playGen++;
    if (_playing) { await _player.stop(); _endPlayback(); }
  }

  Future<File> _download(String url) async {
    final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
    try {
      final req = await c.getUrl(Uri.parse(url));
      req.headers.set('X-Quetzal-Token', _token);
      req.headers.set('x-token', _token);
      final res = await req.close().timeout(const Duration(seconds: 30));
      if (res.statusCode != 200) { await res.drain<void>(); throw StateError('HTTP ${res.statusCode}'); }
      final dir = await Directory.systemTemp.createTemp('quetzal-voice-');
      final f = File('${dir.path}${Platform.pathSeparator}${voiceFileName(url)}');
      await res.pipe(f.openWrite());
      return f;
    } finally {
      c.close(force: true);
    }
  }

  static void _delete(File f) { try { f.parent.deleteSync(recursive: true); } catch (e) { debugPrint('删临时语音失败：$e'); } }
}
