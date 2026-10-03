// 连接一个 agent：探活 →（必要时点火）→ 申请配对码 → 输入配对码 → 连接。
// 这台手机上还没有运行基座时，首选入口是「在这台手机上安装」（安装向导，装完自动连接，不需要配对码）。
import 'package:flutter/material.dart';
import '../api.dart';
import '../igniter.dart';
import '../widgets.dart';
import 'agents.dart';
import 'setup.dart';

class PairingPage extends StatefulWidget {
  const PairingPage({super.key});
  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  bool? alive;
  bool termux = false; // 这台手机装了 Termux：可以在本机安装运行基座
  bool requested = false, busy = false;
  final code = TextEditingController();
  final base = TextEditingController(text: api.base);

  @override
  void initState() { super.initState(); _probe(); }

  Future<void> _probe() async { final ok = await api.health(); final t = await Igniter.available(); if (mounted) setState(() { alive = ok; termux = t; }); }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(24), children: [
          const SizedBox(height: 24),
          const Center(child: Orb(mode: 'asleep', alertness: 0.5)),
          Text('连接一个 agent', style: t.headlineSmall, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Text('控制台会找到运行基座，并通过配对码与它建立信任。', style: t.bodyMedium, textAlign: TextAlign.center),
          const SizedBox(height: 24),
          if (alive == false && api.profiles.length <= 1) Card(child: ListTile(
            leading: const Icon(Icons.phone_android),
            title: const Text('在这台手机上安装 Windler'),
            subtitle: Text(termux ? '已装 Termux，几分钟装好，自动连接' : '需要先安装 Termux；向导会一步步带你完成'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () async { await Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage())); _probe(); },
          )),
          ListTile(
            leading: Icon(alive == true ? Icons.check_circle : alive == false ? Icons.error : Icons.hourglass_empty, color: alive == true ? Colors.green : alive == false ? Colors.red : null),
            title: Text(alive == true ? '找到了运行中的运行基座' : alive == false ? '没有找到运行中的运行基座' : '正在寻找…'),
            subtitle: Text(api.base),
            trailing: alive == false
                ? FilledButton.tonal(
                    onPressed: busy ? null : () async {
                      setState(() => busy = true);
                      final e = await Igniter.ignite();
                      if (e != null && context.mounted) toast(context, e);
                      await Future.delayed(const Duration(seconds: 4));
                      await _probe();
                      setState(() => busy = false);
                    },
                    child: const Text('点火'))
                : IconButton(onPressed: _probe, icon: const Icon(Icons.refresh)),
          ),
          const SizedBox(height: 12),
          if (alive == true && !requested)
            FilledButton.icon(
              icon: const Icon(Icons.link),
              label: const Text('申请配对码'),
              onPressed: () async {
                await act(context, api.pairStart);
                setState(() => requested = true);
              },
            ),
          if (requested) ...[
            Text('配对码已通过系统通知（以及已绑定的飞书）发出，5 分钟内有效。', style: t.bodySmall),
            const SizedBox(height: 8),
            TextField(controller: code, keyboardType: TextInputType.number, maxLength: 6, decoration: const InputDecoration(labelText: '6 位配对码', border: OutlineInputBorder())),
            FilledButton(
              onPressed: () => act(context, () => api.pairFinish(code.text), ok: '配对成功'),
              child: const Text('完成配对'),
            ),
            TextButton(onPressed: () => act(context, api.pairStart, ok: '已重新发送'), child: const Text('没收到？重新发送')),
          ],
          const SizedBox(height: 24),
          if (api.profiles.length > 1) TextButton(onPressed: () => showAgentSheet(context), child: const Text('切换到其他 agent')),
          ExpansionTile(initiallyExpanded: api.profiles.length > 1, title: const Text('网关地址'), children: [
            TextField(controller: base, decoration: const InputDecoration(labelText: '网关地址', helperText: '默认 http://127.0.0.1:7788；同一台设备上的其他 agent 使用各自的端口')),
            TextButton(onPressed: () async { await api.saveSettings(base: base.text.trim()); _probe(); }, child: const Text('保存并重新探测')),
          ]),
        ]),
      ),
    );
  }
}
