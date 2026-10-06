// 连接一个 agent：探活 →（必要时点火）→ 申请配对码 → 输入配对码 → 连接。
// 这台手机上还没有运行基座、App 又内置了它时，直接进安装向导（装完自动连接，不需要配对码），不让人先选。
// 别的机器上的运行基座只走加密连接（https://地址:7789）：先取 /pair/info，原生平台记下握手时看到的证书指纹并钉住、显示给人核对，
// 配对码与这个指纹一起算出配对证明再提交（pins.dart）。网页版的证书由浏览器处理：人在浏览器的警告页上核对指纹。
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../api.dart';
import '../igniter.dart';
import '../pins.dart';
import '../widgets.dart';
import '../platform/caps.dart';
import 'agents.dart';
import 'setup.dart';

class PairingPage extends StatefulWidget {
  const PairingPage({super.key});
  @override
  State<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends State<PairingPage> {
  bool? alive;
  bool bundled = false; // 这个 App 内置了运行基座：可以在本机安装
  bool requested = false, busy = false, autoSetup = false;
  PairInfo? info; // 加密连接：运行基座的证书指纹（给人核对）
  String probeError = '';
  final code = TextEditingController();
  late final base = TextEditingController(text: isLegacyLan(api.base) ? (normalizeBase(api.base) ?? api.base) : api.base);

  bool get secure => Uri.tryParse(api.base)?.scheme == 'https';

  Timer? _again; // 本机的运行基座还没起来（刚登录桌面、刚装好）：隔几秒再找，找到就免配对码登录

  @override
  void initState() { super.initState(); _probe(); }
  @override
  void dispose() { _again?.cancel(); super.dispose(); }

  Future<void> _probe() async {
    var ok = false;
    PairInfo? i;
    var err = '';
    if (secure) { // 加密连接：/pair/info 同时是探活与取证书指纹（原生平台在这一步钉住）
      try { i = await api.pairInfo(); ok = i != null; if (!ok) err = '这个地址上的运行基座版本太旧，不支持加密配对'; } catch (e) { err = '$e'; }
    } else {
      ok = await api.health();
    }
    final t = hasBody && await Igniter.available(); // 这个 App 内置了运行基座
    if (mounted) setState(() { alive = ok; bundled = t; info = i; probeError = err; });
    // 新装的 App：直接开始安装（只自动进一次；从向导返回后留在这一页）
    if (!ok && t && !secure && api.profiles.length <= 1 && !autoSetup && mounted) {
      autoSetup = true;
      await Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage()));
      if (mounted) _probe();
      return;
    }
    final local = (isWeb || isDesktop) && !secure && api.current != null && Api.canLocalLogin(api.current!);
    if (ok && local && await api.localLogin()) api.connect(); // 网页版与桌面版：同一台机器直接登录
    _again?.cancel();
    if (!ok && local && mounted) _again = Timer(const Duration(seconds: 3), () { if (mounted && !requested) _probe(); });
  }

  Future<void> _saveBase() async {
    final b = normalizeBase(base.text);
    if (b == null) { toast(context, '地址不对，例如 192.168.1.8'); return; }
    base.text = b;
    await api.saveSettings(base: b);
    setState(() { requested = false; info = null; alive = null; });
    _probe();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final legacy = api.lastError == legacyLanMessage;
    return Scaffold(
      body: SafeArea(
        child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 560), child: ListView(padding: const EdgeInsets.all(24), children: [
          const SizedBox(height: 24),
          const Center(child: Orb(mode: 'asleep', alertness: 0.5)),
          Text('连接', style: t.headlineSmall, textAlign: TextAlign.center),
          const SizedBox(height: 24),
          if (legacy) Card(child: ListTile(
            leading: const Icon(Icons.lock_outline, color: Colors.orange),
            title: const Text(legacyLanMessage),
            subtitle: const Text('地址已换成加密连接，重新配对即可'),
          )),
          if (hasBody && alive == false && api.profiles.length <= 1 && !secure) Card(child: ListTile(
            leading: const Icon(Icons.phone_android),
            title: const Text('在这台手机上安装'),
            subtitle: bundled ? null : const Text('这个版本没有内置运行环境'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () async { await Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage())); _probe(); },
          )),
          ListTile(
            leading: Icon(alive == true ? Icons.check_circle : alive == false ? Icons.error : Icons.hourglass_empty, color: alive == true ? Colors.green : alive == false ? Colors.red : null),
            title: Text(alive == true ? '找到了${info != null && info!.body.isNotEmpty ? ' ${info!.body}' : ''}' : alive == false ? '没有找到' : '正在寻找…'),
            subtitle: Text(probeError.isEmpty ? api.base : '${api.base}\n$probeError'),
            trailing: alive == false && hasBody && !secure
                ? FilledButton.tonal(
                    onPressed: busy ? null : () async {
                      setState(() => busy = true);
                      final e = await Igniter.ignite();
                      if (e != null && context.mounted) toast(context, e);
                      await Future.delayed(const Duration(seconds: 4));
                      await _probe();
                      setState(() => busy = false);
                    },
                    child: const Text('启动'))
                : IconButton(onPressed: _probe, icon: const Icon(Icons.refresh)),
          ),
          if (secure && info != null) Card(child: ListTile(
            leading: const Icon(Icons.verified_user_outlined),
            title: Text('证书指纹 ${shortFingerprint(info!.fingerprint)}'),
            subtitle: Text(isWeb
                ? '和配对通知里的一样再继续；浏览器的证书 SHA-256 应以 ${shortFingerprint(info!.fingerprint).replaceAll(' ', '')} 开头'
                : '和配对通知里的一样再继续'),
            onLongPress: () { Clipboard.setData(ClipboardData(text: info!.fingerprint)); toast(context, '已复制完整指纹'); },
          )),
          const SizedBox(height: 12),
          if (alive == true && !requested)
            FilledButton.icon(
              icon: const Icon(Icons.link),
              label: const Text('获取配对码'),
              onPressed: () async {
                await act(context, api.pairStart);
                setState(() => requested = true);
              },
            ),
          if (requested) ...[
            Text('配对码已发到那台设备的通知里', style: t.bodySmall),
            const SizedBox(height: 8),
            TextField(controller: code, textCapitalization: TextCapitalization.characters, autocorrect: false, maxLength: 9, decoration: const InputDecoration(labelText: '配对码', hintText: 'ABCD-EFGH', border: OutlineInputBorder())),
            FilledButton(
              onPressed: busy ? null : () async {
                setState(() => busy = true);
                await act(context, () => api.pairFinish(code.text), ok: '配对成功');
                if (mounted) setState(() => busy = false);
              },
              child: Text(busy ? '正在核对…' : '配对'),
            ),
            TextButton(onPressed: () => act(context, api.pairStart, ok: '已重新发送'), child: const Text('重新发送')),
          ],
          const SizedBox(height: 24),
          if (api.profiles.length > 1) TextButton(onPressed: () => showAgentSheet(context), child: const Text('切换')),
          ExpansionTile(initiallyExpanded: api.profiles.length > 1 || legacy || secure, title: const Text('连接另一台设备'), children: [
            TextField(controller: base, decoration: const InputDecoration(labelText: '地址', hintText: '192.168.1.8')),
            TextButton(onPressed: _saveBase, child: const Text('连接')),
          ]),
        ]))),
      ),
    );
  }
}
