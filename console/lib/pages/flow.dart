// 心流：她经历了什么。按时间倒序的时间线，可展开看理由、日记（Markdown）、工具调用；点「完整过程」进入只读的醒来记录页；可筛选；可切换到醒来分布。
// 她正在思考 / 做梦时，列表顶部出现进行中的入口。
//   手机：FlowPage（可展开的卡片）。桌面：FlowList 在列表栏（一行一条，点选），主区显示那一条的完整过程（WakeView）或分布图；两者共用 FlowFeed 的加载逻辑。
import 'dart:async';
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../process.dart';
import '../widgets.dart';
import 'wake.dart';

/// 多具身体：别的身体上发生的，标出在哪里。
String _at(Map e) => e['body'] != null && '${e['body']}' != api.body && api.body.isNotEmpty ? ' · 在 ${e['body']}' : '';

const kinds = {'think': ('思考', Icons.psychology), 'dream': ('梦', Icons.nights_stay), 'chat': ('对话', Icons.chat), 'doze': ('小憩', Icons.snooze), 'sleep': ('入睡', Icons.bedtime), 'wake': ('醒来', Icons.wb_sunny), 'approval': ('审批', Icons.gavel), 'stop': ('急停', Icons.pan_tool), 'boot': ('苏醒', Icons.power_settings_new), 'safe': ('安全模式', Icons.warning), 'hear': ('听见', Icons.hearing), 'tool': ('工具', Icons.handyman), 'identity': ('身份', Icons.badge), 'agent': ('子 agent', Icons.smart_toy_outlined), 'session': ('会话', Icons.forum_outlined), 'place': ('选身体', Icons.devices), 'mesh': ('多具身体', Icons.lan), 'soul': ('灵魂同步', Icons.cloud_sync)};

/// 时间线的加载：筛选、翻页、实时追加。FlowPage 与 FlowList 共用。
class FlowFeed extends ChangeNotifier {
  final items = <Map>[];
  String? kind;
  bool loading = false;
  StreamSubscription? _sub;

  FlowFeed() {
    _sub = api.events.where((e) => e.name == 'timeline').listen((e) { if (kind == null || (e.data as Map)['kind'] == kind) { items.insert(0, e.data as Map); notifyListeners(); } });
    load(reset: true);
  }

  @override
  void dispose() { _sub?.cancel(); super.dispose(); }

  Future<void> filter(String? k) { kind = k; return load(reset: true); }

  Future<void> load({bool reset = false}) async {
    if (loading) return;
    loading = true; notifyListeners();
    try {
      final before = reset || items.isEmpty ? null : items.last['id'];
      final l = await api.call<List>('timeline', {'limit': 40, 'before': ?before, 'kind': ?kind});
      if (reset) items.clear();
      items.addAll(l.cast<Map>());
    } catch (_) {}
    loading = false; notifyListeners();
  }

  Map? byId(Object? id) => items.where((e) => '${e['id']}' == '$id').firstOrNull;
}

const flowFilters = ['think', 'dream', 'chat', 'sleep', 'wake', 'approval'];

/// 筛选条：分布 / 全部 / 各类。
class FlowFilterBar extends StatelessWidget {
  final FlowFeed feed;
  final bool dist;
  final void Function(bool dist) onDist;
  const FlowFilterBar({super.key, required this.feed, required this.dist, required this.onDist});
  @override
  Widget build(BuildContext context) => SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 8), children: [
          Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: const Text('分布'), selected: dist, onSelected: (v) => onDist(v))),
          Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: const Text('全部'), selected: feed.kind == null && !dist, onSelected: (_) { onDist(false); feed.filter(null); })),
          for (final k in flowFilters)
            Padding(padding: const EdgeInsets.all(4), child: ChoiceChip(label: Text(kinds[k]!.$1), selected: feed.kind == k && !dist, onSelected: (_) { onDist(false); feed.filter(k); })),
        ]),
      );
}

/// 手机：心流页。
class FlowPage extends StatefulWidget {
  const FlowPage({super.key});
  @override
  State<FlowPage> createState() => _FlowPageState();
}

class _FlowPageState extends State<FlowPage> {
  final feed = FlowFeed();
  bool dist = false;

  @override
  void dispose() { feed.dispose(); super.dispose(); }

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: Listenable.merge([feed, wakes]), builder: (context, _) => Column(children: [
      FlowFilterBar(feed: feed, dist: dist, onDist: (v) => setState(() => dist = v)),
      Expanded(
        child: dist
            ? FlowDistribution(feed.items)
            : NotificationListener<ScrollNotification>(
                onNotification: (n) { if (n.metrics.extentAfter < 300) feed.load(); return false; },
                child: RefreshIndicator(
                  onRefresh: () => feed.load(reset: true),
                  child: ListView.builder(
                    itemCount: wakes.list.length + (feed.items.isEmpty ? 1 : feed.items.length),
                    itemBuilder: (_, i) => i < wakes.list.length
                        ? LiveWakeTile(wakes.list[i]) // 进行中：她正在思考 / 做梦
                        : feed.items.isEmpty
                            ? const Padding(padding: EdgeInsets.all(32), child: Text('还没有经历', textAlign: TextAlign.center))
                            : _Entry(feed.items[i - wakes.list.length]),
                  ),
                ),
              ),
      ),
    ]));
}

/// 桌面列表栏：一行一条经历，点选后在主区看完整过程。selected 为经历 id、`live:<turn>` 或 `dist`。
class FlowList extends StatelessWidget {
  final FlowFeed feed;
  final String? selected;
  final void Function(String id) onSelect;
  const FlowList({super.key, required this.feed, required this.selected, required this.onSelect});
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme, t = Theme.of(context).textTheme;
    final dist = selected == 'dist';
    return ListenableBuilder(listenable: Listenable.merge([feed, wakes]), builder: (context, _) => Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 6, 2),
        child: Row(children: [
          Expanded(child: Text(feed.kind == null ? '经历' : '经历 · ${kinds[feed.kind]!.$1}', style: t.labelLarge?.copyWith(color: cs.onSurfaceVariant))),
          PopupMenuButton<String>(
            tooltip: '筛选', iconSize: 18, padding: EdgeInsets.zero, icon: Icon(Icons.filter_list, color: feed.kind == null ? cs.onSurfaceVariant : cs.primary),
            onSelected: (v) { feed.filter(v.isEmpty ? null : v); if (dist) onSelect(''); },
            itemBuilder: (_) => [
              CheckedPopupMenuItem(value: '', checked: feed.kind == null, child: const Text('全部')),
              for (final k in flowFilters) CheckedPopupMenuItem(value: k, checked: feed.kind == k, child: Text(kinds[k]!.$1)),
            ],
          ),
          IconButton(tooltip: '醒来分布', iconSize: 18, visualDensity: VisualDensity.compact, icon: Icon(Icons.bar_chart, color: dist ? cs.primary : cs.onSurfaceVariant),
              onPressed: () => onSelect(dist ? (feed.items.isEmpty ? '' : '${feed.items.first['id']}') : 'dist')),
        ]),
      ),
      Expanded(
        child: NotificationListener<ScrollNotification>(
          onNotification: (n) { if (n.metrics.extentAfter < 300) feed.load(); return false; },
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: 24),
            itemCount: wakes.list.length + (feed.items.isEmpty ? 1 : feed.items.length),
            itemBuilder: (_, i) {
              if (i < wakes.list.length) { final w = wakes.list[i]; return LiveWakeTile(w, selected: selected == 'live:${w.id}', onTap: () => onSelect('live:${w.id}')); }
              if (feed.items.isEmpty) return Padding(padding: const EdgeInsets.all(32), child: Text(feed.loading ? '' : '还没有经历', textAlign: TextAlign.center, style: TextStyle(color: cs.outline)));
              final e = feed.items[i - wakes.list.length];
              final k = kinds[e['kind']] ?? ('${e['kind']}', Icons.circle);
              return ListTile(
                dense: true,
                selected: selected == '${e['id']}',
                leading: Icon(k.$2, size: 18),
                title: Text('${e['title']}', maxLines: 2, overflow: TextOverflow.ellipsis),
                subtitle: Text('${k.$1} · ${hm(e['ts'])}${_at(e)}', style: t.labelSmall?.copyWith(color: cs.outline)),
                onTap: () => onSelect('${e['id']}'),
              );
            },
          ),
        ),
      ),
    ]));
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
    final tile = ListTile(leading: Icon(k.$2), title: Text('${e['title']}'), subtitle: Text('${k.$1} · ${hm(e['ts'])}${_at(e)}'));
    if (!has) return Card(child: tile);
    return Card(
      child: ExpansionTile(
        leading: Icon(k.$2),
        title: Text('${e['title']}'),
        subtitle: Text('${k.$1} · ${hm(e['ts'])}${_at(e)}${d['model'] != null ? ' · ${d['model']}' : ''}'),
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
class FlowDistribution extends StatelessWidget {
  final List<Map> items;
  const FlowDistribution(this.items, {super.key});
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
