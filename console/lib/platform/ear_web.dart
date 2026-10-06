// 网页版：没有麦克风与播放（耳朵在手机 App 或桌面版里）。
class DesktopEar {
  static final instance = DesktopEar();
  static bool get supported => false;
  Stream<Map<String, dynamic>> get events => const Stream.empty();
  bool get running => false;
  int mutedUntil = 0;
  Future<void> start({required String base, required String token, required int sensitivity}) async {}
  Future<void> stop() async {}
  Future<bool> play(String id, String url) async => false;
  Future<void> stopPlayback() async {}
}
