// 桌面版耳朵的断句：与安卓的 HearingService 同一套参数——
//   VAD 逐 20 ms 帧判断有没有人声，起止带迟滞（连续 100 ms 有人声才算开始说话，连续 1.5 秒没有才算说完：太短会把句中停顿当成结束），
//   一句话开始时带上之前 300 ms（前置缓冲，补上起音与迟滞的那 100 ms），单段最长 120 秒（超过就先送出去，接着开新的一句）。
//   她在说话时（mute）不断句、不送：桌面上没有系统级回声消除，麦克风里会有她自己的声音（见 console/docs/ARCHITECTURE.md）。
//   纯 Dart：判断人声的函数由调用方给（libfvad，见 platform/fvad.dart），测试里换成假的。
import 'dart:collection';
import 'dart:typed_data';
import 'pcm.dart';

class Segmenter {
  static const prerollFrames = 15; // 300 ms
  static const speechFrames = 5; // 100 ms
  static const silenceFrames = 75; // 1.5 s
  static const maxFrames = 6000; // 120 s

  final bool Function(Int16List frame) isSpeech;
  /// 一句话开始：startedAt 为这句话（含前置缓冲）开始的时刻（毫秒），送 /hear 时带上。
  final void Function(int startedAt) onStart;
  final void Function(Int16List frame) onFrame;
  /// 一句话结束：reason 为 silence / too-long / stop / speaking；ms 为这句话的长度。
  final void Function(String reason, int ms) onEnd;
  final int Function() now;

  Segmenter({required this.isSpeech, required this.onStart, required this.onFrame, required this.onEnd, int Function()? now})
      : now = now ?? (() => DateTime.now().millisecondsSinceEpoch);

  final _preroll = ListQueue<Int16List>();
  bool _voiced = false; // 迟滞之后的状态：此刻算不算有人在说话
  int _speechRun = 0, _silenceRun = 0;
  int _frames = 0; // 进行中的这句话已经送了多少帧
  bool _open = false;

  bool get inUtterance => _open;

  /// 喂一帧（20 ms，16 kHz 单声道）。
  void feed(Int16List frame) {
    final raw = isSpeech(frame);
    if (raw) {
      _speechRun++; _silenceRun = 0;
      if (!_voiced && _speechRun >= speechFrames) _voiced = true;
    } else {
      _silenceRun++; _speechRun = 0;
      if (_voiced && _silenceRun >= silenceFrames) _voiced = false;
    }
    if (_voiced) {
      if (!_open) {
        _open = true; _frames = 0;
        onStart(now() - _preroll.length * frameMs);
        for (final p in _preroll) { onFrame(p); _frames++; }
        _preroll.clear();
      }
      onFrame(frame); _frames++;
      if (_frames >= maxFrames) _close('too-long');
    } else {
      if (_open) _close('silence');
      if (_preroll.length == prerollFrames) _preroll.removeFirst();
      _preroll.add(frame);
    }
  }

  void _close(String reason) {
    if (!_open) return;
    _open = false;
    onEnd(reason, _frames * frameMs);
    _frames = 0;
  }

  /// 不再听（关耳朵）或她开始说话：结束进行中的这句话，清空迟滞与前置缓冲（她的声音不该算进下一句的开头）。
  void reset(String reason) {
    _close(reason);
    _voiced = false; _speechRun = 0; _silenceRun = 0;
    _preroll.clear();
  }
}
