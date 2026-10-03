// 此刻：她现在怎么样。光团 + 状态 + 她想分享的一句话（Markdown）+ 她正在想什么（只读入口）+ 戳一下 / 聊天（首屏）+ 驱动力 + 身体。
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import '../hearing.dart';
import 'sessions.dart';
import 'wake.dart';

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: Listenable.merge([api, wakes, hearing]), builder: (c, _) => view(c));

  Widget view(BuildContext context) {
    final h = api.heart, d = (h['drives'] as Map?) ?? {}, p = api.physical;
    final raw = (p['raw'] as Map?) ?? {}, feel = (p['feel'] as Map?) ?? {}, bat = raw['battery'] as Map?;
    final mode = api.stopped ? 'stopped' : (h['mode'] ?? 'awake') as String;
    final label = {'stopped': '急停中', 'asleep': '睡着了', 'active': '醒着，在想事情', 'awake': '醒着'}[mode]!;
    final inhibitors = (h['inhibitors'] as List?)?.cast<String>() ?? [];
    final thought = api.status['thought'] as Map?;
    return RefreshIndicator(
      onRefresh: api.refresh,
      child: ListView(padding: const EdgeInsets.only(bottom: 90), children: [
        const SizedBox(height: 8),
        Center(child: Orb(mode: mode, alertness: ((h['alertness'] ?? 0.5) as num).toDouble())),
        Text(label, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
        if ((api.status['hearing'] as Map?)?['enabled'] == true) // 耳朵开着：克制的「在听」标记，有人说话的瞬间亮起
          Padding(padding: const EdgeInsets.only(top: 2), child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(Icons.hearing, size: 13, color: hearing.lit ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.outline),
            const SizedBox(width: 4),
            Text(hearing.caption ?? '', style: Theme.of(context).textTheme.labelSmall?.copyWith(color: hearing.lit ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.outline)),
          ])),
        if (thought != null && '${thought['text'] ?? ''}'.isNotEmpty) // 她想分享的一句话，由她自己维护（share_thought）
          Padding(
            padding: const EdgeInsets.fromLTRB(28, 8, 28, 4),
            child: InkWell( // 折叠时最多 3 行（去掉 Markdown 标记），保证按钮留在首屏；点击看全文（完整 Markdown）
              onTap: () => showDialog(context: context, builder: (x) => AlertDialog(
                  content: SingleChildScrollView(child: RichMarkdown('${thought['text']}')),
                  actions: [TextButton(onPressed: () => Navigator.pop(x), child: const Text('好'))])),
              child: Text('「${plainPreview('${thought['text']}')}」', textAlign: TextAlign.center, maxLines: 3, overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(fontStyle: FontStyle.italic)),
            ),
          ),
        for (final t in wakes.list) LiveWakeTile(t), // 她正在思考 / 做梦：只读地看她在做什么
        if (inhibitors.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text('抑制：${inhibitors.join('、')}', textAlign: TextAlign.center, style: const TextStyle(color: Colors.orange))),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 4), // 首屏可达：放在「内在」卡片上方
          child: Row(children: [
            Expanded(child: FilledButton.tonalIcon(icon: const Icon(Icons.touch_app), label: const Text('戳一下'), onPressed: () => _poke(context))),
            const SizedBox(width: 12),
            Expanded(child: FilledButton.icon(icon: const Icon(Icons.chat_bubble), label: const Text('聊天'), onPressed: () => openChat(context))),
          ]),
        ),
        Section('内在', [
          DriveBar('好奇', _n(d['curiosity'])),
          DriveBar('表达', _n(d['expression'])),
          DriveBar('想念', _n(d['social'])),
          DriveBar('牵挂', _n(d['openLoops'])),
          const Divider(),
          DriveBar('清醒', _n(h['alertness'])),
          DriveBar('困意', _n(h['S'])),
          Text('醒来率 ${_n(h['ratePerHour']).toStringAsFixed(2)} 次/小时 · 待整理的经历 ${h['unconsolidated'] ?? 0}', style: Theme.of(context).textTheme.bodySmall),
        ]),
        Section('身体', [
          Wrap(spacing: 8, runSpacing: 4, children: [
            if (bat != null) Chip(avatar: Icon(bat['charging'] == true ? Icons.battery_charging_full : Icons.battery_std, size: 18), label: Text('${bat['level']}%')),
            if (bat?['tempC'] != null) Chip(avatar: const Icon(Icons.thermostat, size: 18), label: Text('${bat!['tempC']}°C ${feel['warmth'] ?? ''}')),
            Chip(avatar: const Icon(Icons.light_mode, size: 18), label: Text('${feel['light'] ?? '未知'}${raw['lux'] != null ? ' ${raw['lux']}lx' : ''}')),
            Chip(avatar: const Icon(Icons.vibration, size: 18), label: Text('${feel['stillness'] ?? '未知'}')),
            Chip(avatar: const Icon(Icons.memory, size: 18), label: Text('负载 ${(p['system'] as Map?)?['load1'] ?? '-'}')),
          ]),
        ]),
      ]),
    );
  }

  static double _n(dynamic v) => (v is num) ? v.toDouble() : 0;

  Future<void> _poke(BuildContext context) async {
    final c = TextEditingController();
    final ok = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
      title: const Text('戳一下'),
      content: TextField(controller: c, decoration: const InputDecoration(hintText: '想对她说点什么（可不填）')),
      actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('戳'))],
    ));
    if (ok == true && context.mounted) await act(context, () => api.call('poke', {'note': c.text}), ok: '她感觉到了。要不要回应，由她自己决定。');
  }
}
