// 桌面版耳朵的音频整形：麦克风给的 16 位小端 PCM（任意采样率、声道数，分块到达，块边界可能落在一个采样中间）
//   → 16 kHz 单声道 → 每 20 ms 一帧（320 个采样，与安卓耳朵、运行基座的 /hear?stream=1 一致）。纯 Dart，不依赖平台。
import 'dart:typed_data';

const earRate = 16000;
const frameSamples = 320; // 20 ms
const frameMs = 20;

class PcmFramer {
  /// 输入的采样率与声道数。
  int rate, channels;
  final _pending = BytesBuilder(copy: true); // 不满一个采样帧（所有声道）的尾巴
  final _out = <int>[]; // 已经转换成 16 kHz 单声道、还不够一帧的采样
  double _pos = 0; // 重采样：下一个输出采样在输入里的位置（相对 _prev）
  int? _prev; // 上一块最后一个单声道采样（跨块插值用）

  PcmFramer({this.rate = earRate, this.channels = 1});

  /// 采集端改了格式（Windows 按设备能力调整时会回报）：之后的数据按新格式处理。
  void reconfigure({required int rate, required int channels}) {
    if (rate == this.rate && channels == this.channels) return;
    this.rate = rate; this.channels = channels;
    _pending.clear(); _pos = 0; _prev = null;
  }

  /// 喂入一块原始字节，返回凑齐的 20 ms 帧。
  List<Int16List> add(List<int> chunk) {
    final ch = channels < 1 ? 1 : channels;
    final stride = 2 * ch;
    _pending.add(chunk);
    final all = _pending.takeBytes();
    final whole = all.length - all.length % stride;
    if (whole < all.length) _pending.add(Uint8List.sublistView(all, whole));
    final data = ByteData.sublistView(all, 0, whole);
    final n = whole ~/ stride;
    final mono = Int16List(n);
    for (var i = 0; i < n; i++) {
      var sum = 0;
      for (var c = 0; c < ch; c++) { sum += data.getInt16((i * ch + c) * 2, Endian.little); }
      mono[i] = sum ~/ ch;
    }
    _resample(mono);
    final frames = <Int16List>[];
    while (_out.length >= frameSamples) {
      frames.add(Int16List.fromList(_out.sublist(0, frameSamples)));
      _out.removeRange(0, frameSamples);
    }
    return frames;
  }

  /// 线性插值重采样到 16 kHz。降采样前先对相邻采样取平均做最简单的低通（语音识别够用，避免高频折叠成噪声）。
  void _resample(Int16List mono) {
    if (mono.isEmpty) return;
    if (rate == earRate) { _out.addAll(mono); return; }
    var src = mono;
    final ratio = rate / earRate; // 每个输出采样前进多少个输入采样
    if (ratio >= 2) {
      final k = ratio.floor();
      final smooth = Int16List(src.length);
      var acc = 0;
      final window = <int>[];
      for (var i = 0; i < src.length; i++) {
        window.add(src[i]); acc += src[i];
        if (window.length > k) acc -= window.removeAt(0);
        smooth[i] = acc ~/ window.length;
      }
      src = smooth;
    }
    // 输入序列：[_prev] + src；位置 0 对应 _prev（没有时对应 src[0]）
    final seq = _prev == null ? src : (Int16List(src.length + 1)..[0] = _prev!..setRange(1, src.length + 1, src));
    var pos = _prev == null ? 0.0 : _pos;
    while (pos <= seq.length - 1) {
      final i = pos.floor();
      final f = pos - i;
      final a = seq[i], b = i + 1 < seq.length ? seq[i + 1] : seq[i];
      _out.add((a + (b - a) * f).round());
      pos += ratio;
    }
    _prev = seq.last;
    _pos = pos - (seq.length - 1); // 下一块里，位置 0 是这一块的最后一个采样
  }
}

/// 20 ms 帧 → 小端字节（上传 /hear 的请求体）。
Uint8List frameBytes(Int16List frame) {
  final b = ByteData(frame.length * 2);
  for (var i = 0; i < frame.length; i++) { b.setInt16(i * 2, frame[i], Endian.little); }
  return b.buffer.asUint8List();
}
