// 连接一个 agent：探活 →（必要时点火）→ 申请配对码 → 输入配对码 → 连接。
// 这台手机上还没有运行基座时，首选入口是「在这台手机上安装」（安装向导，装完自动连接，不需要配对码）。
// 别的机器上的运行基座只走加密连接（https://地址:7789）：先取 /pair/info，原生平台记下握手时看到的证书指纹并钉住、显示给人核对，
// 配对码与这个指纹一起算出配对证明再提交（pins.dart）。网页版的证书由浏览器处理：人在浏览器的警告页上核对指纹。
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
  bool requested = false, busy = false;
  PairInfo? info; // 加密连接：运行基座的证书指纹（给人核对）
  String probeError = '';
  final code = TextEditingController();
  late final base = TextEditingController(text: isLegacyLan(api.base) ? (normalizeBase(api.base) ?? api.base) : api.base);

  bool get secure => Uri.tryParse(api.base)?.scheme == 'https';

  @override
  void initState() { super.initState(); _probe(); }

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
    if (ok && isWeb && !secure && await api.localLogin()) api.connect(); // 网页版：同一台机器直接登录
  }

  Future<void> _saveBase() async {
    final b = normalizeBase(base.text);
    if (b == null) { toast(context, '地址的写法不对：填 IP 或名字（可带端口），如 192.168.1.8'); return; }
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
          Text('连接一个 agent', style: t.headlineSmall, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Text('控制台会找到运行基座，并通过配对码与它建立信任。', style: t.bodyMedium, textAlign: TextAlign.center),
          const SizedBox(height: 24),
          if (legacy) Card(child: ListTile(
            leading: const Icon(Icons.lock_outline, color: Colors.orange),
            title: const Text(legacyLanMessage),
            subtitle: const Text('别的机器上的运行基座现在只接受加密连接（默认端口 7789）。下面的地址已换成加密地址，重新探测并配对即可。'),
          )),
          if (hasBody && alive == false && api.profiles.length <= 1 && !secure) Card(child: ListTile(
            leading: const Icon(Icons.phone_android),
            title: const Text('在这台手机上安装 Quetzal'),
            subtitle: Text(bundled ? '不用再装别的，一分钟左右装好，自动连接' : '这个构建没有内置运行基座（开发版）'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () async { await Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage())); _probe(); },
          )),
          ListTile(
            leading: Icon(alive == true ? Icons.check_circle : alive == false ? Icons.error : Icons.hourglass_empty, color: alive == true ? Colors.green : alive == false ? Colors.red : null),
            title: Text(alive == true ? '找到了运行中的运行基座${info != null && info!.body.isNotEmpty ? '（${info!.body}）' : ''}' : alive == false ? '没有找到运行中的运行基座' : '正在寻找…'),
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
                    child: const Text('点火'))
                : IconButton(onPressed: _probe, icon: const Icon(Icons.refresh)),
          ),
          if (secure && info != null) Card(child: ListTile(
            leading: const Icon(Icons.verified_user_outlined),
            title: Text('证书指纹 ${shortFingerprint(info!.fingerprint)}'),
            subtitle: Text(isWeb
                ? '与配对通知（或那台机器上 quetzal status）里的指纹核对。浏览器提示证书不受信任时，在警告页查看证书，SHA-256 指纹应以 ${shortFingerprint(info!.fingerprint).replaceAll(' ', '')} 开头。'
                : '与配对通知（或那台机器上 quetzal status）里的指纹核对一致再继续；之后这个连接只认这张证书。'),
            onLongPress: () { Clipboard.setData(ClipboardData(text: info!.fingerprint)); toast(context, '已复制完整指纹'); },
          )),
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
            Text(isWeb ? '配对码已发到运行基座所在机器的桌面通知（以及已绑定的飞书）；没有桌面的机器从 quetzal logs 里看。5 分钟内有效。' : '配对码已通过系统通知（以及已绑定的飞书）发出，5 分钟内有效。', style: t.bodySmall),
            if (secure) Text('通知里同时有证书指纹，应与上面显示的一致。配对码只在本机参与计算，不会发到网络上。', style: t.bodySmall),
            const SizedBox(height: 8),
            TextField(controller: code, textCapitalization: TextCapitalization.characters, autocorrect: false, maxLength: 9, decoration: const InputDecoration(labelText: '配对码（8 位，如 ABCD-EFGH；旧版运行基座为 6 位数字）', border: OutlineInputBorder())),
            FilledButton(
              onPressed: busy ? null : () async {
                setState(() => busy = true);
                await act(context, () => api.pairFinish(code.text), ok: '配对成功');
                if (mounted) setState(() => busy = false);
              },
              child: Text(busy ? '正在核对…' : '完成配对'),
            ),
            TextButton(onPressed: () => act(context, api.pairStart, ok: '已重新发送'), child: const Text('没收到？重新发送')),
          ],
          const SizedBox(height: 24),
          if (api.profiles.length > 1) TextButton(onPressed: () => showAgentSheet(context), child: const Text('切换到其他 agent')),
          ExpansionTile(initiallyExpanded: api.profiles.length > 1 || legacy || secure, title: const Text('网关地址'), children: [
            TextField(controller: base, decoration: InputDecoration(labelText: '网关地址', helperMaxLines: 3, helperText: isWeb
                ? '默认是托管这个页面的网关；别的机器填它的地址（需对局域网开放，npx @plutokeating/quetzal --lan），走加密端口 7789'
                : '别的机器只填它的地址（如 192.168.1.8），自动使用加密连接 https://…:7789；同一台设备上的运行基座是 http://127.0.0.1:7788')),
            TextButton(onPressed: _saveBase, child: const Text('保存并重新探测')),
          ]),
        ]))),
      ),
    );
  }
}
