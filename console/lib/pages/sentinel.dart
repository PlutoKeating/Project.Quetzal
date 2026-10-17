// 安全审核（运行基座的 guard/sentinel.ts）：权限页里的「安全审核」一节与各档位的名字，操作记录里审核结论的一行摘要。
// 档位：审核（交给独立的审核模型，缺省）· 允许 · 询问（人工审批）· 禁止。审核配置全网共用（网关 sentinel / setSentinel）。
import 'dart:convert';
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';

/// 权限档位的显示顺序与名字。
const permissionLevels = {'review': '审核', 'allow': '允许', 'ask': '询问', 'deny': '禁止'};

/// 审核失败（超时、模型出错、回答不合格式）时怎么办。
const sentinelFailure = {'by_risk': '按风险：低风险放行，高风险拦下', 'allow': '一律放行', 'block': '一律拦下', 'ask': '转给我审批'};

/// 审核结论的名字（审计 action 为 sentinel.review 的 args.decision）。
const sentinelDecisions = {'allow': '通过', 'revise': '建议换个做法', 'block': '未通过', 'error': '没有完成', 'stopped': '调用已停止'};

/// 一条审核记录（审计）的一行摘要：「通过 · 风险 low · 模型 · 1.2 秒：理由」。不是审核记录返回 null。
String? reviewSummary(Map row) {
  if (row['action'] != 'sentinel.review') return null;
  Map a;
  try { a = (row['args'] is String ? jsonDecode(row['args'] as String) : row['args']) as Map; } catch (_) { return null; }
  final ms = a['ms'] is num ? ' · ${((a['ms'] as num) / 1000).toStringAsFixed(1)} 秒' : '';
  final model = '${a['model'] ?? ''}'.isEmpty ? '' : ' · ${a['model']}';
  final why = '${a['reason'] ?? ''}'.isNotEmpty ? '${a['reason']}' : '${a['error'] ?? ''}';
  return '${a['tool'] ?? ''}：${sentinelDecisions[a['decision']] ?? a['decision']} · 风险 ${a['risk'] ?? '?'}$model$ms${why.isEmpty ? '' : '：$why'}';
}

/// 权限页里的「安全审核」：开关、审核模型、「允许」之下也送审的类别、失败时怎么办、真实环境的请求交给谁。
class SentinelSection extends StatefulWidget {
  const SentinelSection({super.key});
  @override
  State<SentinelSection> createState() => _SentinelSectionState();
}

class _SentinelSectionState extends State<SentinelSection> {
  Map? v;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async { final r = await act(context, () => api.call<Map>('sentinel')); if (mounted && r != null) setState(() => v = r); }
  Future<void> _set(Map<String, dynamic> patch) async {
    final r = await act(context, () => api.call<Map>('setSentinel', patch));
    if (mounted && r != null) setState(() => v = r);
  }

  @override
  Widget build(BuildContext context) {
    final v = this.v;
    final t = Theme.of(context).textTheme;
    if (v == null) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
    final c = v['config'] as Map;
    final on = c['enabled'] == true;
    final classes = (c['classes'] as List).map((e) => '$e').toSet();
    final models = (v['models'] as List).cast<Map>();
    final model = '${c['model'] ?? ''}';
    return Section('安全审核', [
      Text('有风险的操作在执行前交给一个独立的审核模型判断：它只看到这一次操作，看不到她的对话与提示词。没通过时她会收到理由，自己换个做法；不需要你逐条审批。', style: t.bodySmall),
      SwitchListTile(contentPadding: EdgeInsets.zero, title: const Text('启用审核模型'), subtitle: on ? null : const Text('关着时，「审核」档位改为每次询问你'), value: on, onChanged: (x) => _set({'enabled': x})),
      if (on) ...[
        DropdownButtonFormField<String>(
          key: ValueKey('model:$model'),
          initialValue: models.any((m) => m['id'] == model) ? model : '',
          isExpanded: true,
          decoration: const InputDecoration(labelText: '审核模型'),
          items: [
            const DropdownMenuItem(value: '', child: Text('快速模型（缺省）')),
            for (final m in models) DropdownMenuItem(value: '${m['id']}', child: Text('${m['label']}', overflow: TextOverflow.ellipsis)),
          ],
          onChanged: (x) => _set({'model': x ?? ''}),
        ),
        const SizedBox(height: 12),
        Text('「允许」的能力里，这些操作也先审核', style: t.labelLarge),
        const SizedBox(height: 4),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final k in (v['classes'] as List).cast<Map>())
            FilterChip(
              label: Text('${k['label']}'),
              selected: classes.contains(k['id']),
              onSelected: (x) => _set({'classes': x ? [...classes, '${k['id']}'] : classes.where((e) => e != k['id']).toList()}),
            ),
        ]),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          key: ValueKey('fail:${c['onFailure']}'),
          initialValue: sentinelFailure.containsKey(c['onFailure']) ? '${c['onFailure']}' : 'by_risk',
          isExpanded: true,
          decoration: const InputDecoration(labelText: '审核没有结论时（超时、出错）'),
          items: [for (final e in sentinelFailure.entries) DropdownMenuItem(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis))],
          onChanged: (x) => _set({'onFailure': x ?? 'by_risk'}),
        ),
      ],
      const SizedBox(height: 12),
      Text('她请求进入真实环境（命令不经沙箱）', style: t.labelLarge),
      const SizedBox(height: 4),
      SegmentedButton<String>(
        showSelectedIcon: false,
        segments: const [ButtonSegment(value: 'review', label: Text('交给审核模型')), ButtonSegment(value: 'ask', label: Text('每次问我'))],
        selected: {c['hostMode'] == 'ask' || !on ? 'ask' : 'review'},
        onSelectionChanged: on ? (x) => _set({'hostMode': x.first}) : null,
      ),
    ]);
  }
}
