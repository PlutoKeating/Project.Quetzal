// 控制 · 听觉：开关、灵敏度、会话窗口、识别语言、麦克风权限；此刻在不在听、最近听到了什么。
//   耳朵是这台手机上的控制台（前台服务常驻麦克风），识别在基座（Azure，与「语音」页同一把密钥）。听到的话以「环境声音」进入会话，她自己判断要不要回应。
import 'package:flutter/material.dart';
import '../api.dart';
import '../hearing.dart';
import '../widgets.dart';

class HearingPage extends StatefulWidget {
  const HearingPage({super.key});
  @override
  State<HearingPage> createState() => _HearingPageState();
}

class _HearingPageState extends State<HearingPage> {
  Map? st;
  final window = TextEditingController(), language = TextEditingController(), minChars = TextEditingController();
  @override
  void initState() { super.initState(); hearing.refreshPermission(); _load(); }
  Future<void> _load() async {
    final r = await act(context, () => api.call<Map>('hearing'));
    if (!mounted || r == null) return;
    setState(() { st = r; window.text = '${r['windowMin']}'; language.text = '${r['language'] ?? ''}'; minChars.text = '${r['minChars']}'; });
  }
  Future<void> _set(Map<String, dynamic> patch) async {
    final r = await act(context, () => api.call<Map>('setHearing', patch));
    if (r != null && mounted) setState(() => st = r);
    await api.refresh();
    hearing.sync();
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('听觉')),
      body: st == null ? const Center(child: CircularProgressIndicator()) : ListenableBuilder(listenable: hearing, builder: (context, _) {
        final s = st!;
        final reasons = (s['reasons'] as List?)?.cast<String>() ?? [];
        final last = hearing.lastHeard ?? (s['last'] as Map?);
        return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
          Padding(padding: const EdgeInsets.all(16), child: Text('开着时，这台手机的控制台常驻用麦克风听（通知栏有「Quetzal 在听」）。听到有人说话就转成文字交给 ${api.name}，在会话里显示为「环境声音」；是不是在对她说、要不要回应，由她自己判断。识别用「语音」页里的 Azure 密钥。')),
          SwitchListTile(
            title: const Text('开启听觉'), subtitle: Text(reasons.isEmpty ? (hearing.running ? '正在听' : '基座已就绪，等待本机开麦克风') : '没在听：${reasons.join('、')}'),
            value: s['enabled'] == true, onChanged: (v) => _set({'enabled': v}),
          ),
          if (!hearing.granted) ListTile(
            leading: Icon(Icons.mic_off, color: cs.error), title: const Text('还没有麦克风权限'), subtitle: const Text('点这里授权；拒绝过的话去系统设置里打开'),
            onTap: () async { await Hearing.requestPermission(); await Future.delayed(const Duration(seconds: 2)); await hearing.refreshPermission(); hearing.sync(); },
          ),
          if (!HearingController.local(api.base)) const ListTile(leading: Icon(Icons.info_outline), title: Text('当前连接的 agent 不在这台手机上'), subtitle: Text('耳朵只给本机的 agent 用；连回本机的 agent 后再开')),
          if (hearing.error != null) ListTile(leading: Icon(Icons.error_outline, color: cs.error), title: Text(hearing.error!)),
          Section('此刻', [
            Row(children: [
              Icon(Icons.hearing, size: 18, color: hearing.speaking ? cs.primary : cs.outline), const SizedBox(width: 8),
              Text(hearing.running ? (hearing.speaking ? '有人在说话…' : '在听') : '没在听'),
              const Spacer(),
              if (s['speaking'] == true) Text('她在说话', style: Theme.of(context).textTheme.bodySmall),
            ]),
            if (last != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(
              '最近一句：${'${last['text'] ?? ''}'.isEmpty ? '（没听清）' : last['text']}${last['dropped'] != null ? '（${last['dropped']}）' : ''}',
              style: Theme.of(context).textTheme.bodySmall)),
          ]),
          Section('灵敏度', [
            const Text('1 只认清晰的近距离说话，3 轻声也算。太灵敏会把电视、旁人的交谈也送给她。', style: TextStyle(fontSize: 12)),
            SegmentedButton<int>(
              segments: const [ButtonSegment(value: 1, label: Text('迟钝')), ButtonSegment(value: 2, label: Text('适中')), ButtonSegment(value: 3, label: Text('灵敏'))],
              selected: {((s['sensitivity'] ?? 2) as num).toInt()}, onSelectionChanged: (v) => _set({'sensitivity': v.first}),
            ),
          ]),
          Section('会话', [
            const Text('最近一个会话在这么多分钟内有更新，听到的话就并入它；否则新开一个会话，标题取第一句话。填 0 表示每句话都新开。', style: TextStyle(fontSize: 12)),
            Row(children: [
              Expanded(child: TextField(controller: window, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '窗口（分钟）', border: OutlineInputBorder()))),
              const SizedBox(width: 8),
              Expanded(child: TextField(controller: minChars, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: '最短字数', helperText: '短于此当没听清', border: OutlineInputBorder()))),
            ]),
            const SizedBox(height: 8),
            TextField(controller: language, decoration: const InputDecoration(labelText: '识别语言（如 zh-CN；留空取她的偏好语言）', border: OutlineInputBorder())),
            const SizedBox(height: 8),
            FilledButton(onPressed: () => _set({'windowMin': double.tryParse(window.text) ?? 10, 'minChars': int.tryParse(minChars.text) ?? 2, 'language': language.text.trim()}), child: const Text('保存')),
          ]),
          Section('说明', [
            const Text('• 她说话（voice_speak）期间听到的是她自己，这段时间开始的声音会被丢掉。\n• 电量低于预算里的下限（充电时除外）或温度过高时自动停听。\n• 她自己也能用 hearing_config 开关或调整这些设置。\n• 录音不保存，只保留识别出的文字。', style: TextStyle(fontSize: 12)),
          ]),
        ]);
      }),
    );
  }
}
