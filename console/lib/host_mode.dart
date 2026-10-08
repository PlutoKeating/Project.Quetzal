// 真实环境（运行基座的 host-mode.ts）：某个会话里她的命令不经沙箱、直接在主机上执行。
//   HostModeBar：放在对话里——她的请求（同意 / 拒绝）、开启时的红色警示条（退出）。
//   HostModeBanner：放在外壳顶部——任何会话开着真实环境都看得见。
//   HostModeButton：对话页标题栏的开关，对方自己打开或退出。
//   状态来自 status.host（运行基座在进出时推送 state），请求是一条普通的审批（status.approvals，args.conv 指明会话）。
import 'package:flutter/material.dart';
import 'api.dart';
import 'widgets.dart';

const hostColor = Color(0xFFE5484D);

List<Map> get hostModes => ((api.status['host'] as List?) ?? const []).cast<Map>();
Map? hostModeOf(String conv) => hostModes.where((h) => h['conv'] == conv).firstOrNull;
Map? hostRequestOf(String conv) => api.approvals.cast<Map>().where((a) => a['body'] == null && '${a['action']}'.contains('真实环境') && (a['args'] as Map?)?['conv'] == conv).firstOrNull;

Future<void> exitHost(BuildContext context, String conv) => act(context, () => api.call('host.exit', {'conv': conv}));

Future<void> enterHost(BuildContext context, String conv) async {
  if (!await confirm(context, '进入真实环境', '这个对话里，${api.name}的命令将不经沙箱，能读写你能读写的一切。')) return;
  if (context.mounted) await act(context, () => api.call('host.enter', {'conv': conv}));
}

class HostModeBar extends ApiWidget {
  final String conv;
  const HostModeBar({super.key, required this.conv});
  @override
  Widget view(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final req = hostRequestOf(conv);
    if (req != null) {
      return Material(
        color: hostColor.withValues(alpha: 0.14),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
          child: Row(children: [
            const Icon(Icons.warning_amber_rounded, color: hostColor, size: 20),
            const SizedBox(width: 8),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text('${api.name}请求进入真实环境', style: t.titleSmall),
              Text('${req['reason']}', maxLines: 3, overflow: TextOverflow.ellipsis, style: t.bodySmall),
            ])),
            TextButton(onPressed: () => act(context, () => api.call('decide', {'id': req['id'], 'approve': false})), child: const Text('拒绝')),
            FilledButton(style: FilledButton.styleFrom(backgroundColor: hostColor, foregroundColor: Colors.white),
                onPressed: () => act(context, () => api.call('decide', {'id': req['id'], 'approve': true})), child: const Text('同意')),
          ]),
        ),
      );
    }
    if (hostModeOf(conv) == null) return const SizedBox.shrink();
    return Material(
      color: hostColor,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
        child: Row(children: [
          const Icon(Icons.terminal, color: Colors.white, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text('真实环境：命令不经沙箱', style: t.labelLarge?.copyWith(color: Colors.white))),
          TextButton(onPressed: () => exitHost(context, conv), style: TextButton.styleFrom(foregroundColor: Colors.white), child: const Text('退出')),
        ]),
      ),
    );
  }
}

class HostModeBanner extends ApiWidget {
  const HostModeBanner({super.key});
  @override
  Widget view(BuildContext context) {
    final l = hostModes;
    if (l.isEmpty) return const SizedBox.shrink();
    final names = l.map((h) => '「${'${h['title']}'.isEmpty ? '对话' : h['title']}」').join('、');
    return Material(
      color: hostColor,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
        child: Row(children: [
          const Icon(Icons.terminal, color: Colors.white, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text('真实环境：$names', maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.labelLarge?.copyWith(color: Colors.white))),
          TextButton(
            onPressed: () async { for (final h in l) { await exitHost(context, '${h['conv']}'); if (!context.mounted) return; } },
            style: TextButton.styleFrom(foregroundColor: Colors.white),
            child: const Text('退出'),
          ),
        ]),
      ),
    );
  }
}

class HostModeButton extends ApiWidget {
  final String conv;
  final double? size;
  const HostModeButton({super.key, required this.conv, this.size});
  @override
  Widget view(BuildContext context) {
    final on = hostModeOf(conv) != null;
    return IconButton(
      tooltip: on ? '退出真实环境' : '真实环境',
      icon: Icon(on ? Icons.terminal : Icons.shield_outlined, size: size, color: on ? hostColor : null),
      onPressed: () => on ? exitHost(context, conv) : enterHost(context, conv),
    );
  }
}
