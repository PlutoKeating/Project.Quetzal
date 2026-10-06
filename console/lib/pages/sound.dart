// 声音：她的声音（Azure 语音：只要密钥——区域由运行基座自动找出；音色、试听；区域与自定义端点收在「更多」）与她的耳朵（听觉开关、灵敏度、麦克风权限、此刻在不在听）。
//   语速、音调、风格、输出格式、会话窗口、识别语言、最短字数由她自己调（voice_config / hearing_config），不放在这里；
//   语音端点只能在这里改（密钥随请求发往端点，不交给她）。耳朵是这台手机上的控制台（前台服务常驻麦克风），识别在基座，用同一把 Azure 密钥。
import 'package:flutter/material.dart';
import '../api.dart';
import '../hearing.dart';
import '../widgets.dart';
import '../platform/caps.dart';

class SoundPage extends StatefulWidget {
  const SoundPage({super.key});
  @override
  State<SoundPage> createState() => _SoundPageState();
}

class _SoundPageState extends State<SoundPage> {
  Map? speech, ear;
  final key = TextEditingController(), region = TextEditingController(), voice = TextEditingController(), endpoint = TextEditingController();

  @override
  void initState() { super.initState(); hearing.refreshPermission(); _load(); }
  Future<void> _load() async {
    final both = await act(context, () => Future.wait([api.call<Map>('speech'), api.call<Map>('hearing')]));
    if (!mounted || both == null) return;
    final r = both[0], h = both[1];
    setState(() {
      speech = r; ear = h;
      region.text = '${r['region'] ?? ''}'; voice.text = '${r['voice'] ?? ''}'; endpoint.text = '${r['endpoint'] ?? ''}';
    });
  }
  Future<void> _save() async {
    // 只发改过的：只给密钥时，运行基座自动找出区域
    final sp = speech ?? {};
    final r = await act(context, () => api.call('setSpeech', {
      if (key.text.trim().isNotEmpty) 'key': key.text.trim(),
      if (region.text.trim() != '${sp['region'] ?? ''}') 'region': region.text.trim(),
      if (endpoint.text.trim() != '${sp['endpoint'] ?? ''}') 'endpoint': endpoint.text.trim(),
    }), ok: '已保存');
    if (r != null) key.clear();
    _load();
  }
  Future<void> _pickVoice() async {
    final loc = voice.text.split('-').take(2).join('-');
    final list = await act(context, () => api.call<List>('speechVoices', {'locale': loc.isEmpty ? 'zh-CN' : loc}));
    if (list == null || !mounted) return;
    final v = await showDialog<Map>(context: context, builder: (x) => SimpleDialog(title: const Text('音色'), children: [
      for (final e in list.cast<Map>()) SimpleDialogOption(onPressed: () => Navigator.pop(x, e), child: Text('${e['local']} · ${e['gender']}')),
    ]));
    if (v == null || !mounted) return;
    setState(() => voice.text = '${v['name']}');
    await act(context, () => api.call('setSpeech', {'voice': '${v['name']}'}));
    _load();
  }
  Future<void> _setEar(Map<String, dynamic> patch) async {
    final r = await act(context, () => api.call<Map>('setHearing', patch));
    if (r != null && mounted) setState(() => ear = r);
    await api.refresh();
    hearing.sync();
  }

  @override
  Widget build(BuildContext context) {
    final sp = speech;
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final muted = t.bodySmall?.copyWith(color: cs.onSurfaceVariant);
    return PageFrame(
      title: '声音',
      body: sp == null ? const Center(child: CircularProgressIndicator()) : ListenableBuilder(listenable: hearing, builder: (context, _) {
        final configured = sp['configured'] == true;
        final four = '${sp['keyLastFour'] ?? ''}';
        return ListView(padding: const EdgeInsets.all(12), children: [
          Section('${api.name}的声音', trailing: configured ? TextButton.icon(icon: const Icon(Icons.play_arrow), label: const Text('试听'), onPressed: () => act(context, () => api.call('speechTest', {'text': '你好，这是我的声音。'}))) : null, [
            TextField(controller: key, obscureText: true, decoration: InputDecoration(labelText: 'Azure 语音密钥', hintText: four.isEmpty ? null : '****$four', floatingLabelBehavior: four.isEmpty ? null : FloatingLabelBehavior.always, border: const OutlineInputBorder())),
            if (configured) ...[
              const SizedBox(height: 8),
              TextField(controller: voice, readOnly: true, onTap: _pickVoice, decoration: const InputDecoration(labelText: '音色', border: OutlineInputBorder(), suffixIcon: Icon(Icons.arrow_drop_down))),
            ],
            ExpansionTile(tilePadding: EdgeInsets.zero, title: Text('更多', style: muted), children: [
              TextField(controller: region, decoration: const InputDecoration(labelText: '区域', hintText: '自动', border: OutlineInputBorder())),
              const SizedBox(height: 8),
              TextField(controller: endpoint, decoration: const InputDecoration(labelText: '自定义端点', hintText: 'https://…', border: OutlineInputBorder())),
              const SizedBox(height: 8),
            ]),
            Align(alignment: Alignment.centerLeft, child: FilledButton(onPressed: _save, child: const Text('保存'))),
          ]),
          if (ear != null) _ear(context, ear!, configured),
        ]);
      }),
    );
  }

  /// 她的耳朵：开关（附带没在听的原因）、麦克风权限、此刻、灵敏度。
  Widget _ear(BuildContext context, Map s, bool configured) {
    final t = Theme.of(context).textTheme, cs = Theme.of(context).colorScheme;
    final reasons = (s['reasons'] as List?)?.cast<String>() ?? [];
    final last = hearing.lastHeard ?? (s['last'] as Map?);
    final on = s['enabled'] == true;
    final status = !configured ? '先填好上面的密钥' : !on ? '' : reasons.isNotEmpty ? reasons.join('、') : !HearingController.canHear ? '在 App 上听' : hearing.running ? (hearing.speaking ? '有人在说话…' : '在听') : '准备中';
    return Section('听你说话', trailing: Switch(value: on, onChanged: configured ? (v) => _setEar({'enabled': v}) : null), [
      if (status.isNotEmpty) Row(children: [
        Icon(Icons.hearing, size: 16, color: hearing.speaking ? cs.primary : cs.outline), const SizedBox(width: 6),
        Expanded(child: Text(status, style: t.bodyMedium)),
        if (s['speaking'] == true) Text('她在说话', style: t.bodySmall),
      ]),
      if (on && last != null && '${last['text'] ?? ''}'.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('「${last['text']}」', style: t.bodySmall?.copyWith(color: cs.onSurfaceVariant))),
      if (hasBody && !hearing.granted) ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(Icons.mic_off, color: cs.error), title: const Text('允许使用麦克风'),
        onTap: () async { await Hearing.requestPermission(); await Future.delayed(const Duration(seconds: 2)); await hearing.refreshPermission(); hearing.sync(); },
      ),
      if (HearingController.canHear && !HearingController.local(api.base)) Text('只能听这台设备上的 agent', style: t.bodySmall),
      if (hearing.error != null) Text(hearing.error!, style: TextStyle(color: cs.error)),
      if (on) ...[
        const SizedBox(height: 12),
        SegmentedButton<int>(
          showSelectedIcon: false,
          segments: const [ButtonSegment(value: 1, label: Text('只听近处')), ButtonSegment(value: 2, label: Text('适中')), ButtonSegment(value: 3, label: Text('轻声也听'))],
          selected: {((s['sensitivity'] ?? 2) as num).toInt()}, onSelectionChanged: (v) => _setEar({'sensitivity': v.first}),
        ),
      ],
    ]);
  }
}
