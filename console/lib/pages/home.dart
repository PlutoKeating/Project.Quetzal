// 此刻：她现在怎么样。光团 + 状态 + 她想分享的一句话（Markdown）+ 她正在想什么（只读入口）+ 戳一下 / 聊天（首屏）+ 驱动力 + 身体。
//   各块都是独立组件（PresenceHead、ThoughtLine、InnerSection、BodySection），手机首页与桌面的「她此刻」面板共用。
import 'package:flutter/material.dart';
import '../api.dart';
import '../markdown.dart';
import '../widgets.dart';
import '../hearing.dart';
import 'sessions.dart';
import 'wake.dart';
import 'providers.dart';
import '../shell/nav.dart';

double _n(dynamic v) => (v is num) ? v.toDouble() : 0;

/// 她此刻的模式（stopped / asleep / active / awake）与一句话。
({String mode, String label}) presenceMode() {
  final mode = api.stopped ? 'stopped' : (api.heart['mode'] ?? 'awake') as String;
  return (mode: mode, label: {'stopped': '急停中', 'asleep': '睡着了', 'active': '醒着，在想事情', 'awake': '醒着'}[mode] ?? mode);
}

/// 光团 + 状态一句话 + 「在听」标记。
class PresenceHead extends StatelessWidget {
  final double size;
  const PresenceHead({super.key, this.size = 200});
  @override
  Widget build(BuildContext context) {
    final h = api.heart, m = presenceMode(), cs = Theme.of(context).colorScheme, t = Theme.of(context).textTheme;
    return Column(children: [
      Center(child: Orb(mode: m.mode, alertness: _n(h['alertness'] ?? 0.5), size: size)),
      Text(m.label, textAlign: TextAlign.center, style: size >= 160 ? t.headlineSmall : t.titleMedium),
      if ((api.status['hearing'] as Map?)?['enabled'] == true) // 耳朵开着：克制的「在听」标记，有人说话的瞬间亮起
        Padding(padding: const EdgeInsets.only(top: 2), child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(Icons.hearing, size: 13, color: hearing.lit ? cs.primary : cs.outline),
          const SizedBox(width: 4),
          Flexible(child: Text(hearing.caption ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: t.labelSmall?.copyWith(color: hearing.lit ? cs.primary : cs.outline))),
        ])),
    ]);
  }
}

/// 她想分享的一句话，由她自己维护（share_thought）。折叠时最多 3 行；点击看全文（完整 Markdown）。没有就不占位。
class ThoughtLine extends StatelessWidget {
  const ThoughtLine({super.key});
  @override
  Widget build(BuildContext context) {
    final thought = api.status['thought'] as Map?;
    if (thought == null || '${thought['text'] ?? ''}'.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 8, 28, 4),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => showDialog(context: context, builder: (x) => AlertDialog(
            content: SingleChildScrollView(child: RichMarkdown('${thought['text']}')),
            actions: [TextButton(onPressed: () => Navigator.pop(x), child: const Text('好'))])),
        child: Text('「${plainPreview('${thought['text']}')}」', textAlign: TextAlign.center, maxLines: 3, overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodyLarge?.copyWith(fontStyle: FontStyle.italic)),
      ),
    );
  }
}

/// 内在：驱动力、清醒与困意、醒来率。
class InnerSection extends StatelessWidget {
  final bool compact;
  const InnerSection({super.key, this.compact = false});
  @override
  Widget build(BuildContext context) {
    final h = api.heart, d = (h['drives'] as Map?) ?? {};
    final rows = [
      DriveBar('好奇', _n(d['curiosity'])), DriveBar('表达', _n(d['expression'])), DriveBar('想念', _n(d['social'])), DriveBar('牵挂', _n(d['openLoops'])),
      const Divider(),
      DriveBar('清醒', _n(h['alertness'])), DriveBar('困意', _n(h['S'])),
      Text('每小时约醒来 ${_n(h['ratePerHour']).toStringAsFixed(1)} 次', style: Theme.of(context).textTheme.bodySmall),
    ];
    return compact ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: rows) : Section('内在', rows);
  }
}

/// 身体读数。
class BodySection extends StatelessWidget {
  final bool compact;
  const BodySection({super.key, this.compact = false});
  @override
  Widget build(BuildContext context) {
    final p = api.physical, raw = (p['raw'] as Map?) ?? {}, feel = (p['feel'] as Map?) ?? {}, bat = raw['battery'] as Map?;
    final chips = Wrap(spacing: 8, runSpacing: 4, children: [
      if (bat != null) Chip(avatar: Icon(bat['charging'] == true ? Icons.battery_charging_full : Icons.battery_std, size: 18), label: Text('${bat['level']}%')),
      if (bat?['tempC'] != null) Chip(avatar: const Icon(Icons.thermostat, size: 18), label: Text('${bat!['tempC']}°C ${feel['warmth'] ?? ''}')),
      Chip(avatar: const Icon(Icons.light_mode, size: 18), label: Text('${feel['light'] ?? '未知'}${raw['lux'] != null ? ' ${raw['lux']}lx' : ''}')),
      Chip(avatar: const Icon(Icons.vibration, size: 18), label: Text('${feel['stillness'] ?? '未知'}')),
      Chip(avatar: const Icon(Icons.memory, size: 18), label: Text('负载 ${(p['system'] as Map?)?['load1'] ?? '-'}')),
    ]);
    return compact ? chips : Section('身体', [chips]);
  }
}

/// 戳一下：只推动她的内在状态，要不要回应由她决定。
Future<void> poke(BuildContext context) async {
  final c = TextEditingController();
  final ok = await showDialog<bool>(context: context, builder: (x) => AlertDialog(
    title: const Text('戳一下'),
    content: TextField(controller: c, autofocus: true, decoration: const InputDecoration(hintText: '想对她说点什么（可不填）')),
    actions: [TextButton(onPressed: () => Navigator.pop(x, false), child: const Text('取消')), FilledButton(onPressed: () => Navigator.pop(x, true), child: const Text('戳'))],
  ));
  if (ok == true && context.mounted) await act(context, () => api.call('poke', {'note': c.text}), ok: '她感觉到了');
}

/// 还没有模型时的唯一提示：她要靠它思考。手机推入模型页，桌面在主区打开。有了模型就不占位。
class ModelNudge extends StatelessWidget {
  const ModelNudge({super.key});
  @override
  Widget build(BuildContext context) {
    if (api.conn != Conn.online || ((api.status['models'] as List?) ?? []).isNotEmpty) return const SizedBox.shrink();
    return Card(margin: const EdgeInsets.fromLTRB(12, 12, 12, 0), child: ListTile(
      leading: const Icon(Icons.hub_outlined),
      title: const Text('选择模型'),
      subtitle: Text('${api.name}要靠它思考'),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => ShellScope.isDesktop(context) ? nav.go('control', id: 'providers') : Navigator.push(context, MaterialPageRoute(builder: (_) => const ProvidersPage())),
    ));
  }
}

/// 手机首页。
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: Listenable.merge([api, wakes, hearing]), builder: (c, _) => view(c));

  Widget view(BuildContext context) {
    final inhibitors = (api.heart['inhibitors'] as List?)?.cast<String>() ?? [];
    return RefreshIndicator(
      onRefresh: api.refresh,
      child: ListView(padding: const EdgeInsets.only(bottom: 90), children: [
        const SizedBox(height: 8),
        const PresenceHead(),
        const ThoughtLine(),
        for (final t in wakes.list) LiveWakeTile(t), // 她正在思考 / 做梦：只读地看她在做什么
        const ModelNudge(),
        if (inhibitors.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(inhibitors.join('、'), textAlign: TextAlign.center, style: const TextStyle(color: Colors.orange))),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 4), // 首屏可达：放在「内在」卡片上方
          child: Row(children: [
            Expanded(child: FilledButton.tonalIcon(icon: const Icon(Icons.touch_app), label: const Text('戳一下'), onPressed: () => poke(context))),
            const SizedBox(width: 12),
            Expanded(child: FilledButton.icon(icon: const Icon(Icons.chat_bubble), label: const Text('聊天'), onPressed: () => openChat(context))),
          ]),
        ),
        const InnerSection(),
        const BodySection(),
      ]),
    );
  }
}
