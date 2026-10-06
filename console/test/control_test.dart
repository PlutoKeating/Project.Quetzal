import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/pages/control.dart';

void main() {
  test('控制首屏只放常用的几项，其余收进「高级」，最后是关于', () {
    final items = controlItems();
    List<String> titles(String g) => items.where((it) => it.group == g).map((it) => it.title).toList();
    expect(titles('main'), ['模型', '权限', '节律', '声音', '飞书', '设备']);
    expect(titles('end'), ['高级', '关于']);
    expect(titles('more'), ['工具', '保密库', '预算', '同步', '记忆历史', '操作记录', '运行']);
    expect(items.map((it) => it.id).toSet().length, items.length);
  });

  test('旧的位置对应到现在的页面，找不到就是身份页', () {
    expect(controlItem('approvals').id, 'permissions');
    expect(controlItem('hearing').id, 'voice');
    expect(controlItem('audit').id, 'audit');
    expect(controlItem('account').id, 'account');
    expect(controlItem('nope').id, 'identity');
    expect(controlItem(null).id, 'identity');
  });
}
