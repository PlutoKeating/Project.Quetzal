// 设备：登录账户，把这台设备与同一个 agent 的其他设备连成一个她（一份对话、一颗心）；看其他设备在不在、怎么连着。
// 状态来自 status.mesh（网关的 mesh 事件实时更新）。同步服务地址与心跳优先级收在「高级 · 同步」，账户管理从这里进。
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../api.dart';
import '../widgets.dart';
import '../links.dart';
import 'account.dart';

/// 与这台设备对齐设置的结果：失败就写原因；采用了对方的哪些设置；都一致时不写。
String _settingsLabel(Map s) {
  final err = '${s['error'] ?? ''}';
  if (err.isNotEmpty) return '设置没同步：$err';
  final took = (s['took'] as List?)?.join('、') ?? '';
  return took.isEmpty ? '' : '采用了它的$took';
}

/// 连接路径的说法：候选类型 host / srflx / prflx / relay → 人话（不显示地址）。
String pathLabel(Map? p) {
  if (p == null) return '';
  final l = '${p['local']}', r = '${p['remote']}';
  final kind = l == 'relay' || r == 'relay' ? '中转' : l == 'host' && r == 'host' ? '局域网' : '直连';
  final rtt = (p['rtt'] as num?)?.toInt() ?? 0;
  return rtt > 0 ? '$kind · ${rtt}ms' : kind;
}

const _linkLabel = {'open': '已连上', 'connecting': '连接中', 'authenticating': '连接中', 'idle': '等待重连', 'closed': '未连接', 'none': '未连接'};
/// 同步服务的状态（「高级 · 同步」也用）。
const meshStateLabel = {'off': '未启用', 'connecting': '连接中', 'online': '已连上', 'offline': '暂时连不上，正在重试', 'unauthorized': '需要重新登录'};

/// 登录这台设备（设备码绑定）：申请到码就直接在浏览器里打开批准页，少点一下。新用户批准时自动建 agent，老用户接进已有的 agent，灵魂仓库随之接好。
Future<void> signInDevice(BuildContext context) async {
  final r = await act(context, () => api.call<Map>('mesh.bind'));
  final uri = (r?['binding'] as Map?)?['uri'];
  if (uri is String && context.mounted) await openExternal(context, uri);
}

/// 绑定 / 登录进行中：核对表情、码、打开链接（也能扫码在另一台设备上批准）。设置向导与账户页共用。
class DeviceCodeView extends StatelessWidget {
  final Map pending;
  final VoidCallback onCancel;
  const DeviceCodeView({super.key, required this.pending, required this.onCancel});
  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final uri = '${pending['uri']}';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if ('${pending['check'] ?? ''}'.isNotEmpty) Center(child: Text('${pending['check']}', style: const TextStyle(fontSize: 40, letterSpacing: 8))),
      Center(child: SelectableText('${pending['code']}', style: t.titleMedium?.copyWith(letterSpacing: 4, fontFamily: 'monospace', color: cs.onSurfaceVariant))),
      const SizedBox(height: 12),
      Center(child: Wrap(spacing: 8, children: [
        FilledButton.icon(icon: const Icon(Icons.open_in_new), label: const Text('在浏览器中继续'), onPressed: () => openExternal(context, uri)),
        IconButton(tooltip: '复制链接', icon: const Icon(Icons.copy, size: 20), onPressed: () { Clipboard.setData(ClipboardData(text: uri)); toast(context, '已复制'); }),
        TextButton(onPressed: onCancel, child: const Text('取消')),
      ])),
      ExpansionTile(tilePadding: EdgeInsets.zero, title: Text('用另一台设备扫码', style: t.bodyMedium), children: [
        Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: uri, size: 180)),
      ]),
    ]);
  }
}

class MeshPage extends StatefulWidget {
  const MeshPage({super.key});
  @override
  State<MeshPage> createState() => _MeshPageState();
}

class _MeshPageState extends State<MeshPage> {
  bool loaded = false;
  @override
  void initState() { super.initState(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('mesh'));
    if (!mounted || r == null) return;
    api.status['mesh'] = r;
    setState(() => loaded = true);
  }

  @override
  Widget build(BuildContext context) {
    return PageFrame(
      title: '设备',
      body: !loaded ? const Center(child: CircularProgressIndicator()) : ListenableBuilder(listenable: api, builder: (context, _) {
        final m = (api.status['mesh'] as Map?) ?? {};
        final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
        final muted = t.bodySmall?.copyWith(color: cs.onSurfaceVariant);
        final peers = ((m['peers'] as List?) ?? []).cast<Map>();
        final binding = m['binding'] as Map?;
        final bound = m['bound'] == true;
        final coordinator = '${m['coordinator'] ?? m['body'] ?? ''}';
        final here = '${m['body'] ?? api.status['body'] ?? '-'}';
        return ListView(padding: const EdgeInsets.all(12), children: [
          if (bound) Card(child: ListTile(
            leading: const Icon(Icons.account_circle_outlined),
            title: Text('${m['account']}'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AccountPage())),
          )),
          if (!bound) Section('登录', [
            if (binding == null) ...[
              Text('登录后，${api.name}在你所有的设备上都是同一个。', style: muted),
              const SizedBox(height: 12),
              if ('${m['server'] ?? ''}'.isNotEmpty) FilledButton(onPressed: () => signInDevice(context), child: const Text('用 GitHub 登录')),
            ],
            if (binding != null) DeviceCodeView(pending: binding, onCancel: () => act(context, () => api.call('mesh.cancelBind'))),
            if ('${m['error'] ?? ''}'.isNotEmpty) Text('${m['error']}', style: TextStyle(color: cs.error)),
          ]),
          if (m['available'] == false) Padding(padding: const EdgeInsets.all(4), child: Text('缺少直连组件，重新安装一次即可补上。', style: TextStyle(color: cs.error))),
          if (bound) Card(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _row(context, api.status['adapter'] == 'linux' ? Icons.computer : Icons.smartphone, '$here（这台）', [if (coordinator == here && peers.isNotEmpty) '心跳在这里'].join()),
            for (final p in peers) _peer(context, p, coordinator),
            if (m['state'] != 'online') Text(meshStateLabel['${m['state']}'] ?? '', style: muted),
          ]))),
          if (bound) Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: () async {
            if (await confirm(context, '退出登录', '这台设备将不再与其他设备直连，记忆仍会同步。') && context.mounted) await act(context, () => api.call('mesh.unbind'), ok: '已退出');
          }, child: Text('这台设备退出登录', style: TextStyle(color: cs.error)))),
          if (!bound || peers.isEmpty) Padding(padding: const EdgeInsets.all(8), child: Text('公钥指纹 ${m['fingerprint'] ?? ''}', style: muted?.copyWith(fontFamily: 'monospace'))),
        ]);
      }),
    );
  }

  Widget _row(BuildContext context, IconData icon, String title, String sub, {Color? color, Widget? trailing}) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon, color: color),
        title: Text(title),
        subtitle: sub.isEmpty ? null : Text(sub),
        trailing: trailing,
      );

  Widget _peer(BuildContext context, Map p, String coordinator) {
    final open = p['link'] == 'open';
    final sub = [
      if (p['kind'] == 'bridge') '灵魂桥',
      if (coordinator == p['body']) '心跳在这里',
      p['online'] == true ? (_linkLabel['${p['link']}'] ?? '${p['link']}') : '离线${(p['lastSeen'] ?? 0) == 0 ? '' : ' · ${hm(p['lastSeen'])}'}',
      if (p['path'] != null) pathLabel(p['path'] as Map),
      if (p['pinMismatch'] == true) '公钥变了，已断开',
      if (p['keyOk'] == false && p['online'] == true && p['pinMismatch'] != true) p['registered'] == false ? '等待记忆同步后连上' : '公钥对不上',
      if ('${p['error'] ?? ''}'.isNotEmpty && !open) '${p['error']}',
      if (open && p['settings'] is Map) _settingsLabel(p['settings'] as Map),
    ].where((s) => s.isNotEmpty).join(' · ');
    return _row(context, open ? Icons.link : p['online'] == true ? Icons.sync : Icons.link_off, '${p['body']}', sub,
        color: open ? Colors.green : null,
        trailing: p['pinMismatch'] == true ? TextButton(onPressed: () async {
          if (await confirm(context, '信任 ${p['body']} 的新公钥', '${p['fingerprint']}\n\n只有你自己重装了它或换了钥匙时才确认。') && context.mounted) {
            await act(context, () => api.call('mesh.acceptPin', {'body': p['body']}), ok: '已确认');
          }
        }, child: const Text('信任')) : null);
  }
}
