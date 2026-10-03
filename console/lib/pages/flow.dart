// 心流：她经历了什么。按时间倒序的时间线，可展开看理由、日记（Markdown）、工具调用；点「完整过程」进入只读的醒来记录页；可筛选；可切换到醒来分布。
// 她正在思考 / 做梦时，列表顶部出现进行中的入口。
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../process.dart';
import '../widgets.dart';
import 'wake.dart';

const kinds = {'think': ('思考', Icons.psychology), 'dream': ('梦', Icons.nights_stay), 'chat': ('对话', Icons.chat), 'doze': ('小憩', Icons.snooze), 'sleep': ('入睡', Icons.bedtime), 'wake': ('醒来', Icons.wb_sunny), 'approval': ('审批', Icons.gavel), 'stop': ('急停', Icons.pan_tool), 'boot': ('苏醒', Icons.power_settings_new), 'safe': ('安全模式', Icons.warning), 'hear': ('听见', Icons.hearing), 'tool': ('工具', Icons.handyman), 'identity': ('身份', Icons.badge), 'agent': ('子 agent', Icons.smart_toy_outlined), 'session': ('会话', Icons.forum_outlined)};

class FlowPage extends StatefulWidget {
  const FlowPage({super.key});
  @override
  State<FlowPage> createState() => _FlowPageState();
}

class _FlowPageState extends State<FlowPage> {
  final items = <Map>[];
  String? kind;
  bool loading = false, dist = false;

  @override
  void initState() {
    super.initState();
    _load(reset: true);
    api.events.where((e) => e.name == 'timeline').listen((e) { if (mounted && (kind == null || (e.data as Map)['kind'] == kind)) setState(() => items.insert(0, e.data as Map)); });
    wakes.addListener(_onWake);
  }

  @override
  void dispose() { wakes.removeListener(_onWake); super.dispose(); }
  void _onWake() { if (mounted) setState(() {}); }

  Future<void> _load({bool reset = false}) async {
    if (loading) return;
    setState(() => loading = true);
    try {
      final before = reset || items.isEmpty ? null : items.last['id'];
      final l = await api.call<List>('timeline', {'limit': 40, 'before': ?before, 'kind': ?kind});
      setState(() { if (reset) items.clear(); items.addAll(l.cast<Map>()); });
    } catch (_) {}
    if (mounted) setState(() => loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 8), children: [
          Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: const Text('分布'), selected: dist, onSelected: (v) => setState(() => dist = v))),
          Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: const Text('全部'), selected: kind == null && !dist, onSelected: (_) { setState(() { kind = null; dist = false; }); _load(reset: true); })),
          for (final k in ['think', 'dream', 'chat', 'sleep', 'wake', 'approval'])
            Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: Text(kinds[k]!.$1), selected: kind == k && !dist, onSelected: (_) { setState(() { kind = k; dist = false; }); _load(reset: true); })),
        ]),
      ),
      Expanded(
        child: dist
            ? _Distribution(items)
            : NotificationListener<ScrollNotification>(
                onNotification: (n) { if (n.metrics.extentAfter < 300) _load(); return false; },
                child: RefreshIndicator(
                  onRefresh: () => _load(reset: true),
                  child: ListView.builder(
                    itemCount: wakes.list.length + (items.isEmpty ? 1 : items.length),
                    itemBuilder: (_, i) => i < wakes.list.length
                        ? LiveWakeTile(wakes.list[i]) // 进行中：她正在思考 / 做梦
                        : items.isEmpty
                            ? const Padding(padding: EdgeInsets.all(32), child: Text('还没有经历', textAlign: TextAlign.center))
                            : _Entry(items[i - wakes.list.length]),
                  ),
                ),
              ),
      ),
    ]);
  }
}

class _Entry extends StatelessWidget {
  final Map e;
  const _Entry(this.e);
  @override
  Widget build(BuildContext context) {
    final k = kinds[e['kind']] ?? ('${e['kind']}', Icons.circle);
    final d = (e['detail'] as Map?) ?? {};
    final steps = (d['steps'] as List?) ?? [], process = (d['process'] as List?) ?? [];
    final has = d['journal'] != null || d['reply'] != null || steps.isNotEmpty || process.isNotEmpty || d['reason'] != null || d['error'] != null;
    final full = process.isNotEmpty || steps.isNotEmpty || d['journal'] != null || d['reply'] != null; // 可以进只读的完整过程页
    final tile = ListTile(leading: Icon(k.$2), title: Text('${e['title']}'), subtitle: Text('${k.$1} · ${hm(e['ts'])}'));
    if (!has) return Card(child: tile);
    return Card(
      child: ExpansionTile(
        leading: Icon(k.$2),
        title: Text('${e['title']}'),
        subtitle: Text('${k.$1} · ${hm(e['ts'])}${d['model'] != null ? ' · ${d['model']}' : ''}'),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (d['reason'] != null) Text('因为：${d['reason']}', style: Theme.of(context).textTheme.bodySmall),
          if (d['intent'] != null && '${d['intent']}'.isNotEmpty) Text('想：${d['intent']}', style: Theme.of(context).textTheme.bodySmall),
          if (d['error'] != null) Text('中断了：${d['error']}', style: TextStyle(color: Theme.of(context).colorScheme.error)),
          if (d['text'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: Align(alignment: Alignment.centerRight, child: Bubble('${d['text']}', me: true, channel: d['channel']))),
          if (d['reply'] != null) Bubble('${d['reply']}'),
          if (d['journal'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: RichMarkdown('${d['journal']}')),
          if (d['feeling'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('心情：${d['feeling']}', style: Theme.of(context).textTheme.bodySmall)),
          // 工具调用：与对话页同样的卡片，点开看完整参数与结果
          if (process.isNotEmpty || steps.isNotEmpty) ProcessView(process.isNotEmpty ? process.cast<Map>() : itemsFromSteps(steps), steps: steps.cast<Map>()),
          Row(children: [
            if (d['tokens'] != null) Text('${d['tokens']} tokens', style: Theme.of(context).textTheme.labelSmall),
            const Spacer(),
            if (full) TextButton.icon(icon: const Icon(Icons.visibility_outlined, size: 16), label: const Text('完整过程'), onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => WakePage(entry: e)))),
          ]),
        ],
      ),
    );
  }
}

/// 醒来分布：按小时统计「思考 / 做梦」次数，用来检验节律是否"均匀而不规则"。
class _Distribution extends StatelessWidget {
  final List<Map> items;
  const _Distribution(this.items);
  @override
  Widget build(BuildContext context) {
    final think = List.filled(24, 0), dream = List.filled(24, 0);
    for (final e in items) {
      final h = DateTime.fromMillisecondsSinceEpoch((e['ts'] as num).toInt()).hour;
      if (e['kind'] == 'think' || e['kind'] == 'doze') think[h]++;
      if (e['kind'] == 'dream') dream[h]++;
    }
    final maxV = [...think, ...dream].fold(1, (a, b) => a > b ? a : b);
    final gaps = <double>[];
    final ts = items.where((e) => e['kind'] == 'think').map((e) => (e['ts'] as num).toDouble()).toList()..sort();
    for (var i = 1; i < ts.length; i++) { gaps.add((ts[i] - ts[i - 1]) / 60000); }
    final mean = gaps.isEmpty ? 0 : gaps.reduce((a, b) => a + b) / gaps.length;
    return ListView(padding: const EdgeInsets.all(12), children: [
      Section('按小时的醒来次数（最近 ${items.length} 条经历）', [
        SizedBox(
          height: 160,
          child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            for (var h = 0; h < 24; h++)
              Expanded(child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                Container(height: 120 * dream[h] / maxV, color: Colors.indigo),
                Container(height: 120 * think[h] / maxV, color: Theme.of(context).colorScheme.primary),
                Text(h % 6 == 0 ? '$h' : '', style: const TextStyle(fontSize: 10)),
              ])),
          ]),
        ),
        const Text('紫：思考　靛：做梦', style: TextStyle(fontSize: 12)),
      ]),
      Section('思考之间的间隔', [
        Text(gaps.isEmpty ? '数据还不够' : '平均 ${mean.toStringAsFixed(0)} 分钟 · 最短 ${gaps.reduce((a, b) => a < b ? a : b).toStringAsFixed(0)} · 最长 ${gaps.reduce((a, b) => a > b ? a : b).toStringAsFixed(0)} 分钟'),
        const Text('间隔没有固定周期是正常的：她什么时候醒，取决于她当时的内在状态。', style: TextStyle(fontSize: 12)),
      ]),
    ]);
  }
}
