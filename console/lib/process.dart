// 一轮的执行过程与消息气泡：对话页与「醒来记录」页共用，两边看到的是同一种东西。
//   LiveTurn：进行中的一轮（后端快照 + 推送事件折叠而成，与 runtime mind/activity.ts 的 fold 一致）。
//   ProcessView：工具卡片（执行中 / 完成 / 出错 / 被拒绝，点开看参数与结果）与她中途说的话（完整 Markdown）。
//   Bubble：消息气泡，她的话与对方的话都按完整 Markdown 渲染。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'markdown.dart';
import 'widgets.dart';

/// 进行中的一轮（由后端快照与推送事件共同维护）。
class LiveTurn {
  final String id, origin, conv;
  int msg, step = 0;
  String text, status = 'running', live = '';
  final items = <Map>[];
  LiveTurn(this.id, this.msg, this.text, {this.origin = 'chat', this.conv = ''});
  factory LiveTurn.snapshot(Map t) => LiveTurn('${t['turn']}', (t['msg'] as num?)?.toInt() ?? 0, '${t['text'] ?? ''}', origin: '${t['origin'] ?? 'chat'}', conv: '${t['conv'] ?? ''}')
    ..status = '${t['status'] ?? 'running'}'
    ..step = (t['step'] as num?)?.toInt() ?? 0
    ..live = '${t['live'] ?? ''}'
    ..items.addAll((t['items'] as List? ?? []).cast<Map>());

  /// 把一条进展事件折叠进来。start / steer / done / error / alive 由调用方处理。
  void apply(Map a) {
    switch (a['kind']) {
      case 'queued': status = 'queued';
      case 'step': status = 'running'; step = (a['step'] as num?)?.toInt() ?? step;
      case 'delta': live += '${a['text'] ?? ''}';
      case 'text':
        final t = '${a['text'] ?? ''}'.trim();
        if (a['final'] == true) { live = t; } else { if (t.isNotEmpty) items.add({'type': 'text', 'text': t}); live = ''; }
      case 'tool':
        final i = items.indexWhere((x) => x['type'] == 'tool' && x['call'] == a['call']);
        final item = {'type': 'tool', ...a};
        if (i >= 0) { items[i] = item; } else { items.add(item); }
      case 'steer': // 插话 / 打断到达的那一刻：之前的过程截断在插话消息上方，之后的从它下面重新开出
        items.add({'type': 'steer', 'msg': a['msg'], 'text': a['text'], 'mode': a['mode'], 'ambient': a['ambient']});
    }
  }

  bool get running => items.any((x) => x['type'] == 'tool' && x['status'] == 'running');
  Map? get lastTool { final l = items.where((x) => x['type'] == 'tool'); return l.isEmpty ? null : l.last; }
  String get hint => status == 'queued' ? '排队中（这个会话前面还有话没回完）…' : running ? '正在调用工具…' : live.isEmpty ? '她在想…' : '';
}

/// 把过程按插话标记切成段：第一段挂在这一轮开始的那句话下面，之后每段挂在对应的插话消息下面（msg 为插话消息的 id）。
/// 插话标记本身不渲染（它对应的消息由对话记录里的那条消息显示）。
List<({int? msg, List<Map> items})> splitAtSteer(List<Map> items) {
  final out = <({int? msg, List<Map> items})>[];
  var cur = <Map>[];
  int? msg;
  for (final x in items) {
    if (x['type'] == 'steer') { out.add((msg: msg, items: cur)); cur = <Map>[]; msg = (x['msg'] as num?)?.toInt(); } else { cur.add(x); }
  }
  out.add((msg: msg, items: cur));
  return out;
}

/// 消息气泡：她的话按完整 Markdown 渲染（表格、公式、Mermaid 图）；对方的话同样按 Markdown 渲染，用不同底色区分。
class Bubble extends StatelessWidget {
  final String text;
  final bool me, live, pending;
  final Object? channel;
  const Bubble(this.text, {super.key, this.me = false, this.live = false, this.pending = false, this.channel});
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Opacity(
      opacity: pending ? 0.6 : 1,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(10),
        constraints: BoxConstraints(maxWidth: PaneWidth.of(context) * 0.8),
        decoration: BoxDecoration(color: me ? cs.primaryContainer : cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          RichMarkdown(text, live: live),
          if (channel != null && channel != '控制台') Text('$channel', style: Theme.of(context).textTheme.labelSmall),
        ]),
      ),
    );
  }
}

/// 执行过程：每个工具一行（执行中 / 完成 / 出错 / 被拒绝），点一行看参数摘要与结果；她中途说的话按正常消息气泡完整显示（Markdown）。
/// steps：时间线里保存的完整调用记录（参数与结果全文，不含 finish），与工具卡片按顺序对应，有则在详情里一并显示。
class ProcessView extends StatelessWidget {
  final List<Map> items;
  final List<Map> steps;
  const ProcessView(this.items, {super.key, this.steps = const []});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final small = Theme.of(context).textTheme.bodySmall;
    var k = 0; // 第几个工具调用（finish 不算），用来对应 steps
    return Container(
      margin: const EdgeInsets.only(top: 4),
      constraints: BoxConstraints(maxWidth: PaneWidth.of(context) * 0.9),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final x in items.where((x) => x['type'] != 'steer'))
          if (x['type'] == 'text') // 她中途说的话：正常的消息气泡
            Bubble('${x['text']}')
          else
            Builder(builder: (context) {
              final step = x['name'] == 'finish' ? null : (k < steps.length ? steps[k] : null);
              if (x['name'] != 'finish') k++;
              return InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: () => showToolDetail(context, x, step),
                child: Container(
                  margin: const EdgeInsets.symmetric(vertical: 2),
                  padding: const EdgeInsets.only(left: 8, top: 2, bottom: 2),
                  decoration: BoxDecoration(border: Border(left: BorderSide(color: cs.outlineVariant, width: 2))),
                  child: Row(children: [
                    statusIcon(x['status'], cs),
                    const SizedBox(width: 6),
                    Flexible(
                      child: Text.rich(
                        TextSpan(children: [
                          TextSpan(text: '${x['name']}', style: const TextStyle(fontWeight: FontWeight.bold)),
                          if ('${x['summary'] ?? ''}'.isNotEmpty) TextSpan(text: ' — ${x['summary']}', style: TextStyle(color: cs.onSurfaceVariant)),
                        ]),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: small,
                      ),
                    ),
                    if (x['ms'] != null && x['status'] != 'running') Text('  ${((x['ms'] as num) / 1000).toStringAsFixed(1)}s', style: small?.copyWith(color: cs.outline)),
                  ]),
                ),
              );
            }),
      ]),
    );
  }

  static Widget statusIcon(Object? status, ColorScheme cs) => switch (status) {
        'running' => const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
        'ok' => const Icon(Icons.check_circle, size: 16, color: Colors.green),
        'denied' => Icon(Icons.block, size: 16, color: cs.outline),
        _ => Icon(Icons.error, size: 16, color: cs.error),
      };
}

const _statusLabel = {'running': '执行中', 'ok': '完成', 'denied': '被拒绝', 'error': '出错'};

/// 工具调用详情：名称、状态、耗时、参数摘要、结果开头；有完整记录（时间线的 steps）时给出完整参数与结果。
void showToolDetail(BuildContext context, Map x, Map? step) {
  final t = Theme.of(context).textTheme;
  String pretty(Object? v) {
    if (v is String) return v;
    try { return const JsonEncoder.withIndent('  ').convert(v); } catch (_) { return '$v'; }
  }
  final args = step?['args'], result = step?['result'] ?? x['result'];
  showSheet(context, (_, scroll) => ListView(controller: scroll, padding: const EdgeInsets.all(16), children: [
        Row(children: [
          ProcessView.statusIcon(x['status'], Theme.of(context).colorScheme),
          const SizedBox(width: 8),
          Expanded(child: Text('${x['name']}', style: t.titleMedium)),
          Text('${_statusLabel[x['status']] ?? x['status']}${x['ms'] != null ? ' · ${((x['ms'] as num) / 1000).toStringAsFixed(1)}s' : ''}', style: t.bodySmall),
        ]),
        if ('${x['summary'] ?? ''}'.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text('参数摘要', style: t.labelLarge),
          SelectableText('${x['summary']}', style: t.bodySmall),
        ],
        if (args != null) ...[
          const SizedBox(height: 12),
          Text('完整参数', style: t.labelLarge),
          SelectableText(pretty(args), style: t.bodySmall?.copyWith(fontFamily: 'monospace')),
        ],
        const SizedBox(height: 12),
        Text(step != null ? '结果' : '结果（开头）', style: t.labelLarge),
        if ('${result ?? ''}'.isEmpty) Text('（无）', style: t.bodySmall) else RawOrMarkdown('$result'),
        if (step == null && x['status'] != 'running') Padding(padding: const EdgeInsets.only(top: 8), child: Text('完整内容在心流里', style: t.bodySmall?.copyWith(color: Theme.of(context).colorScheme.outline))),
        const SizedBox(height: 24),
      ]));
}

/// 时间线里的 steps（无 process 的旧记录）折成工具卡片，让旧的醒来记录也能按同一种方式回放。
List<Map> itemsFromSteps(List steps) => [
      for (final s in steps.cast<Map>())
        {'type': 'tool', 'call': '', 'name': '${s['tool']}', 'summary': summarizeArgs(s['args']), 'status': 'ok', 'result': '${s['result'] ?? ''}'.split('\n').firstWhere((l) => l.trim().isNotEmpty, orElse: () => '')},
    ];

/// 参数的一行摘要（与 runtime 的 summarize 同一思路：常见主参数 → 第一个字符串 → JSON）。
String summarizeArgs(Object? args) {
  if (args is! Map) return args == null ? '' : '$args';
  const keys = ['command', 'query', 'url', 'title', 'name', 'id', 'text', 'target', 'action'];
  Object? v = keys.map((k) => args[k]).firstWhere((x) => x is String && x.isNotEmpty, orElse: () => null);
  v ??= args.values.firstWhere((x) => x is String && x.isNotEmpty, orElse: () => null);
  v ??= args.isEmpty ? '' : jsonEncode(args);
  final s = '$v'.replaceAll(RegExp(r'\s+'), ' ').trim();
  return s.length > 100 ? '${s.substring(0, 100)}…' : s;
}

/// 工具卡片的一行说明（进行中的横幅用）：最近的工具与状态。
String describeTurn(LiveTurn t) {
  final last = t.lastTool;
  final where = t.origin == 'dream' ? '做梦（整理记忆）' : t.origin == 'think' ? '醒来思考' : t.origin == 'agent' ? '子 agent' : '对话';
  return '$where · ${t.status == 'queued' ? '排队中' : '第 ${t.step} 步'}${last != null ? ' · ${last['name']}（${_statusLabel[last['status']] ?? last['status']}）' : ''}${t.live.isNotEmpty ? ' · 正在写…' : ''}';
}
