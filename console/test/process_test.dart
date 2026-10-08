// 进行中的一轮：进展事件折叠成快照（与后端 fold 一致），工具卡片与 steps 的对应。
import 'package:flutter_test/flutter_test.dart';
import 'package:quetzal_console/process.dart';

void main() {
  test('LiveTurn.apply 折叠进展事件', () {
    final t = LiveTurn('s1', 0, '光线变化', origin: 'think');
    t.apply({'kind': 'step', 'step': 1});
    t.apply({'kind': 'delta', 'text': '我先'});
    t.apply({'kind': 'delta', 'text': '看看'});
    expect(t.live, '我先看看');
    t.apply({'kind': 'text', 'step': 1, 'text': '我先看看', 'final': false});
    expect(t.live, '');
    expect(t.items.single['text'], '我先看看');
    t.apply({'kind': 'tool', 'call': 'c1', 'name': 'shell', 'summary': 'ls', 'status': 'running'});
    expect(t.running, isTrue);
    expect(t.hint, '正在调用工具…');
    t.apply({'kind': 'tool', 'call': 'c1', 'name': 'shell', 'summary': 'ls', 'status': 'ok', 'ms': 12, 'result': 'a'});
    expect(t.items.length, 2);
    expect(t.items.last['status'], 'ok');
    expect(t.lastTool!['name'], 'shell');
    t.apply({'kind': 'text', 'step': 2, 'text': '**完成**', 'final': true});
    expect(t.live, '**完成**');
    expect(t.hint, '');
    expect(describeTurn(t), contains('醒来思考'));
  });

  test('快照重建与 steps 折成卡片', () {
    final t = LiveTurn.snapshot({'turn': 'x', 'origin': 'dream', 'text': '困了', 'status': 'queued', 'step': 3, 'live': '', 'items': [{'type': 'tool', 'call': 'c', 'name': 'memory', 'status': 'ok'}]});
    expect(t.origin, 'dream');
    expect(t.hint, contains('排队'));
    final items = itemsFromSteps([{'tool': 'shell', 'args': {'command': 'uptime'}, 'result': '\n 1:00 up 2 days\nload'}]);
    expect(items.single['summary'], 'uptime');
    expect(items.single['result'], ' 1:00 up 2 days');
    expect(items.single['status'], 'unknown', reason: '旧记录没有存成败：不画对钩');
    expect(itemsFromSteps([{'tool': 'shell', 'args': {}, 'result': 'exit 1', 'status': 'error'}]).single['status'], 'error');
    expect(summarizeArgs({'a': 1, 'query': 'x' * 120}).length, 101);
  });
}
