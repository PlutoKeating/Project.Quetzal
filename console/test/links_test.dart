// 外部链接只放行 https（http 只限本机回环地址）。
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/links.dart';

void main() {
  test('只放行 https 与本机的 http', () {
    expect(safeExternalUri('https://quetzal.plutokeating.beer/device?code=AB'), isNotNull);
    expect(safeExternalUri(' https://github.com/x '), isNotNull);
    expect(safeExternalUri('http://127.0.0.1:7788/'), isNotNull);
    expect(safeExternalUri('http://localhost/x'), isNotNull);
    expect(safeExternalUri('http://[::1]:7788/'), isNotNull);
    for (final bad in ['http://example.com', 'intent://scan#Intent;scheme=x;end', 'file:///sdcard/a', 'javascript:alert(1)', 'content://x/y', 'tel:123', 'https://user:pw@example.com/', 'https:///nohost', '', 'not a url']) {
      expect(safeExternalUri(bad), isNull, reason: bad);
    }
  });
}
