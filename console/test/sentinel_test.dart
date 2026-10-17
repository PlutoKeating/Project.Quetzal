import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/sentinel.dart';

void main() {
  test('档位：审核排在最前（缺省），询问仍可选', () {
    expect(permissionLevels.keys.toList(), ['review', 'allow', 'ask', 'deny']);
    expect(permissionLevels['ask'], '询问');
  });

  test('操作记录里审核结论的一行摘要：结论、风险、模型、耗时、理由', () {
    expect(reviewSummary({'action': 'sentinel.review', 'args': '{"tool":"shell","decision":"block","risk":"high","model":"P/m","ms":1234,"reason":"会读基座的密钥"}'}),
        'shell：未通过 · 风险 high · P/m · 1.2 秒：会读基座的密钥');
    expect(reviewSummary({'action': 'sentinel.review', 'args': {'tool': 'send_message', 'decision': 'error', 'risk': 'high', 'ms': 20000, 'error': '20 秒内没有结论'}}),
        'send_message：没有完成 · 风险 high · 20.0 秒：20 秒内没有结论');
    expect(reviewSummary({'action': 'shell', 'args': '{}'}), isNull);
    expect(reviewSummary({'action': 'sentinel.review', 'args': 'not json'}), isNull);
  });
}
