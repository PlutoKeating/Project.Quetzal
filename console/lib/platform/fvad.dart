// libfvad（WebRTC VAD）的 dart:ffi 绑定：桌面版耳朵逐 20 ms 帧判断有没有人声。
//   共享库随控制台一起构建（console/native/fvad/）：Linux 在可执行文件旁的 lib/libfvad.so，Windows 是 exe 旁边的 fvad.dll。
//   模式与安卓耳朵一致：灵敏度 1 迟钝 → 3（很激进，只认清楚的人声），2 适中 → 2，3 灵敏 → 0（轻声也算）。
//   只在 dart:io 平台导入（网页版没有 dart:ffi）。
import 'dart:ffi';
import 'dart:io' show File, Platform;
import 'dart:typed_data';
import 'package:ffi/ffi.dart' show calloc;

final class _FvadInst extends Opaque {}

typedef _NewC = Pointer<_FvadInst> Function();
typedef _FreeC = Void Function(Pointer<_FvadInst>);
typedef _FreeD = void Function(Pointer<_FvadInst>);
typedef _SetC = Int32 Function(Pointer<_FvadInst>, Int32);
typedef _SetD = int Function(Pointer<_FvadInst>, int);
typedef _ProcessC = Int32 Function(Pointer<_FvadInst>, Pointer<Int16>, Size);
typedef _ProcessD = int Function(Pointer<_FvadInst>, Pointer<Int16>, int);

/// 灵敏度（运行基座的 hearing.sensitivity：1 迟钝 / 2 适中 / 3 灵敏）→ WebRTC VAD 的模式。
int vadMode(int sensitivity) => switch (sensitivity) { 1 => 3, 3 => 0, _ => 2 };

class Fvad {
  /// 控制台自带的共享库在哪（测试里可以给别的路径）。
  static String defaultLibrary() => Platform.isWindows ? 'fvad.dll' : '${File(Platform.resolvedExecutable).parent.path}/lib/libfvad.so';

  late final Pointer<_FvadInst> _inst;
  late final _FreeD _free;
  late final _SetD _setMode;
  late final _ProcessD _process;
  Pointer<Int16> _buf = nullptr;
  int _cap = 0;
  bool _closed = false;

  /// [mode] 0–3；采样率固定 16 kHz。共享库或函数缺失时抛出。
  Fvad({int mode = 2, String? library}) {
    final lib = DynamicLibrary.open(library ?? defaultLibrary());
    _inst = lib.lookupFunction<_NewC, _NewC>('fvad_new')();
    if (_inst == nullptr) throw StateError('fvad_new 失败');
    _free = lib.lookupFunction<_FreeC, _FreeD>('fvad_free');
    _setMode = lib.lookupFunction<_SetC, _SetD>('fvad_set_mode');
    _process = lib.lookupFunction<_ProcessC, _ProcessD>('fvad_process');
    if (lib.lookupFunction<_SetC, _SetD>('fvad_set_sample_rate')(_inst, 16000) != 0) throw StateError('fvad 不支持 16 kHz');
    this.mode = mode;
  }

  set mode(int m) { if (_setMode(_inst, m.clamp(0, 3)) != 0) throw StateError('fvad 模式无效：$m'); }

  /// 这一帧（10 / 20 / 30 ms）里有没有人声。
  bool isSpeech(Int16List frame) {
    if (_closed) return false;
    if (frame.length > _cap) {
      if (_buf != nullptr) calloc.free(_buf);
      _buf = calloc<Int16>(frame.length); _cap = frame.length;
    }
    _buf.asTypedList(frame.length).setAll(0, frame);
    final r = _process(_inst, _buf, frame.length);
    if (r < 0) throw StateError('fvad 帧长不对：${frame.length}');
    return r == 1;
  }

  void dispose() {
    if (_closed) return;
    _closed = true;
    _free(_inst);
    if (_buf != nullptr) calloc.free(_buf);
    _buf = nullptr;
  }
}
