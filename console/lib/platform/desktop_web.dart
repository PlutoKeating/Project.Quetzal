// 网页版：没有本机文件，也不看护任何进程。
Future<String?> readLocalGatewayToken() async => null;
Future<bool> verifyLocalToken(int port, String token) async => false;

class BodyHelper {
  static final instance = BodyHelper();
  void start() {}
  Future<void> stop() async {}
  void check() {}
}
