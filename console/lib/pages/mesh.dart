// 多具身体：把这具身体接入同步服务，与同一个 agent 的其他身体直连成一个心智（一份对话、一颗心）。
// 状态来自 status.mesh（网关的 mesh 事件实时更新）：同步服务、绑定进展、各身体的连接（直连 / 中转、往返时间）、谁持有心跳。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../api.dart';
import '../widgets.dart';
import '../links.dart';

/// 连接路径的说法：候选类型 host / srflx / prflx / relay → 人话（不显示地址）。
String pathLabel(Map? p) {
  if (p == null) return '';
  final l = '${p['local']}', r = '${p['remote']}';
  final kind = l == 'relay' || r == 'relay' ? '经服务器中转' : l == 'host' && r == 'host' ? '局域网直连' : '穿透直连';
  final rtt = (p['rtt'] as num?)?.toInt() ?? 0;
  return rtt > 0 ? '$kind · ${rtt}ms' : kind;
}

const _linkLabel = {'open': '已连上', 'connecting': '连接中', 'authenticating': '核对身份中', 'idle': '等待重连', 'closed': '未连接', 'none': '未连接'};
const _stateLabel = {'off': '未启用', 'connecting': '正在连接同步服务', 'online': '已连上同步服务', 'offline': '同步服务暂时连不上，正在重试', 'unauthorized': '同步服务不认这具身体了，请重新绑定'};

class MeshPage extends StatefulWidget {
  const MeshPage({super.key});
  @override
  State<MeshPage> createState() => _MeshPageState();
}

class _MeshPageState extends State<MeshPage> {
  final server = TextEditingController();
  bool loaded = false;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('mesh'));
    if (!mounted || r == null) return;
    api.status['mesh'] = r;
    setState(() { server.text = '${r['server'] ?? ''}'; loaded = true; });
  }

  @override
  Widget build(BuildContext context) {
    return PageFrame(
      title: '多具身体',
      body: !loaded ? const Center(child: CircularProgressIndicator()) : ListenableBuilder(listenable: api, builder: (context, _) {
        final m = (api.status['mesh'] as Map?) ?? {};
        final t = Theme.of(context).textTheme;
        final peers = ((m['peers'] as List?) ?? []).cast<Map>();
        final binding = m['binding'] as Map?;
        final bound = m['bound'] == true;
        final coordinator = '${m['coordinator'] ?? m['body'] ?? ''}';
        return ListView(padding: const EdgeInsets.all(12), children: [
          const Padding(padding: EdgeInsets.all(4), child: Text('同一个 agent 可以同时住在几部手机、几台电脑上。接入同一个同步服务后，这些身体直接连在一起：对话、会话、心跳与设置是同一份；她可以选在哪具身体上思考，也能用另一具身体的相机、命令行。连不上时，身体之间仍通过灵魂仓库同步记忆。')),
          Section('同步服务', [
            TextField(controller: server, decoration: const InputDecoration(labelText: '地址（默认是官方同步服务）', border: OutlineInputBorder())),
            const SizedBox(height: 8),
            Row(children: [
              FilledButton.tonal(onPressed: () async { await act(context, () => api.call('mesh.setServer', {'server': server.text.trim()}), ok: '已保存'); _load(); }, child: const Text('保存')),
              const SizedBox(width: 12),
              Expanded(child: Text(_stateLabel['${m['state']}'] ?? '${m['state']}', style: t.bodySmall)),
            ]),
            if ('${m['error'] ?? ''}'.isNotEmpty) Text('${m['error']}', style: const TextStyle(color: Colors.red)),
            const Text('默认用官方同步服务，不用改。想自己部署（仓库里的 sync/ 目录，一行命令启动）就把地址填在这里；清空后保存即恢复官方。同步服务只负责让身体互相找到、连不上时中转，看不到对话与记忆。', style: TextStyle(fontSize: 12)),
          ]),
          Section('这具身体', [
            Text('身体：${m['body'] ?? api.status['body'] ?? '-'}'),
            Row(children: [const Text('公钥指纹：'), SelectableText('${m['fingerprint'] ?? ''}', style: const TextStyle(fontFamily: 'monospace'))]),
            if (m['available'] == false) const Text('缺少直连组件：重新运行一次安装即可补上。', style: TextStyle(color: Colors.orange)),
            if (bound) Text('已绑定到账户 ${m['account']}'),
            if (!bound && binding == null && '${m['server'] ?? ''}'.isNotEmpty)
              FilledButton(onPressed: () => act(context, () => api.call('mesh.bind')), child: const Text('绑定到同步服务')),
            if (binding != null) ...[
              const SizedBox(height: 8),
              const Text('在浏览器里打开下面的链接（用 GitHub 登录），输入绑定码，并核对网页上的公钥指纹与这里一致，再点「批准」。'),
              const SizedBox(height: 8),
              SelectableText('${binding['code']}', style: t.headlineMedium?.copyWith(letterSpacing: 4, fontFamily: 'monospace')),
              Wrap(spacing: 8, children: [
                FilledButton.icon(icon: const Icon(Icons.open_in_new), label: const Text('打开链接'), onPressed: () => openExternal(context, '${binding['uri']}')),
                TextButton.icon(icon: const Icon(Icons.copy), label: const Text('复制链接'), onPressed: () { Clipboard.setData(ClipboardData(text: '${binding['uri']}')); toast(context, '已复制'); }),
                TextButton(onPressed: () => act(context, () => api.call('mesh.cancelBind')), child: const Text('取消')),
              ]),
              const Text('或者用另一台设备扫码：'),
              Center(child: Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: '${binding['uri']}', size: 180))),
              const Text('等待批准中…（15 分钟内有效）'),
            ],
            if (bound) Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () async {
              if (await confirm(context, '解绑', '这具身体会离开同步服务，不再与其他身体直连（记忆仍经灵魂仓库同步）。确定吗？') && context.mounted) await act(context, () => api.call('mesh.unbind'), ok: '已解绑');
            }, child: const Text('解绑'))),
          ]),
          if (bound) Section('其他身体', [
            if (peers.isEmpty) const Text('这个 agent 还没有其他身体绑定到同步服务。'),
            for (final p in peers) ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(p['link'] == 'open' ? Icons.link : p['online'] == true ? Icons.sync : Icons.link_off, color: p['link'] == 'open' ? Colors.green : null),
              title: Text('${p['body']}${coordinator == p['body'] ? '  · 心跳在这里' : ''}'),
              subtitle: Text([
                p['kind'] == 'bridge' ? '灵魂桥（只读）' : '运行基座 ${p['version'] ?? ''}',
                p['online'] == true ? (_linkLabel['${p['link']}'] ?? '${p['link']}') : '离线${(p['lastSeen'] ?? 0) == 0 ? '' : '（上次在线 ${hm(p['lastSeen'])}）'}',
                if (p['path'] != null) pathLabel(p['path'] as Map),
                if (p['pinMismatch'] == true) '公钥或类型与第一次见到时不同，已断开：确认是你自己重装或换了钥匙再点「确认」',
                if (p['keyOk'] == false && p['online'] == true && p['pinMismatch'] != true) '公钥与灵魂仓库登记的不一致（等灵魂仓库同步，或检查是否被冒充）',
                if ('${p['error'] ?? ''}'.isNotEmpty && p['link'] != 'open') '${p['error']}',
              ].where((s) => s.isNotEmpty).join(' · ')),
              trailing: p['pinMismatch'] == true ? TextButton(onPressed: () async {
                if (await confirm(context, '确认 ${p['body']} 的新公钥', '新的公钥指纹：${p['fingerprint']}\n\n只有在你确定是自己重装了那具身体、或换了它的钥匙时才确认；否则可能有人在冒充它。确认后这具身体重新连上。') && context.mounted) {
                  await act(context, () => api.call('mesh.acceptPin', {'body': p['body']}), ok: '已确认');
                }
              }, child: const Text('确认')) : null,
            ),
            Text(coordinator == m['body'] ? '此刻心跳在这具身体上：由它决定什么时候醒来。' : '此刻心跳在 $coordinator 上，这具身体跟随。', style: t.bodySmall),
          ]),
          if (bound) Section('当协调者的优先级', [
            const Text('几具身体都在线时，优先级大的持有心跳（决定什么时候醒来）；一样大时，接着电源的、开得久的优先。一直开着、接着电源的身体（例如服务器）适合调高。'),
            _PriorityField(initial: (m['priority'] as num?)?.toInt() ?? 0),
          ]),
        ]);
      }),
    );
  }
}

class _PriorityField extends StatefulWidget {
  final int initial;
  const _PriorityField({required this.initial});
  @override
  State<_PriorityField> createState() => _PriorityFieldState();
}

class _PriorityFieldState extends State<_PriorityField> {
  late double v = widget.initial.toDouble();
  @override
  Widget build(BuildContext context) => Row(children: [
        Expanded(child: Slider(value: v, min: 0, max: 10, divisions: 10, label: '${v.round()}', onChanged: (x) => setState(() => v = x),
            onChangeEnd: (x) => act(context, () => api.call('mesh.setPriority', {'priority': x.round()}), ok: '已保存'))),
        Text('${v.round()}'),
      ]);
}
