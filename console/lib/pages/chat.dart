// 对话：与她说话；她主动说的话也会出现在这里。
import 'package:flutter/material.dart';
import '../api.dart';
import '../widgets.dart';

class ChatPage extends StatefulWidget {
  const ChatPage({super.key});
  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final msgs = <Map>[];
  final input = TextEditingController();
  final scroll = ScrollController();
  bool thinking = false;

  @override
  void initState() {
    super.initState();
    api.call<List>('messages', {'limit': 60}).then((l) => setState(() => msgs.addAll(l.cast<Map>()))).catchError((_) {});
    api.events.where((e) => e.name == 'say').listen((e) { if (mounted) setState(() => msgs.add({'role': 'amani', 'channel': '主动', 'text': e.data, 'ts': DateTime.now().millisecondsSinceEpoch})); });
  }

  Future<void> _send() async {
    final t = input.text.trim();
    if (t.isEmpty || thinking) return;
    input.clear();
    setState(() { msgs.add({'role': 'user', 'channel': '控制台', 'text': t}); thinking = true; });
    final r = await act(context, () => api.call<String>('chat.send', {'text': t}));
    if (mounted) setState(() { if (r != null) msgs.add({'role': 'amani', 'channel': '控制台', 'text': r}); thinking = false; });
    await Future.delayed(const Duration(milliseconds: 50));
    if (scroll.hasClients) scroll.jumpTo(scroll.position.maxScrollExtent);
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('和薰说话')),
      body: Column(children: [
        Expanded(
          child: ListView.builder(
            controller: scroll,
            padding: const EdgeInsets.all(12),
            itemCount: msgs.length + (thinking ? 1 : 0),
            itemBuilder: (_, i) {
              if (i == msgs.length) return const Align(alignment: Alignment.centerLeft, child: Padding(padding: EdgeInsets.all(8), child: Text('她在想…')));
              final m = msgs[i], me = m['role'] == 'user';
              return Align(
                alignment: me ? Alignment.centerRight : Alignment.centerLeft,
                child: Container(
                  margin: const EdgeInsets.symmetric(vertical: 4),
                  padding: const EdgeInsets.all(10),
                  constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
                  decoration: BoxDecoration(color: me ? cs.primaryContainer : cs.surfaceContainerHighest, borderRadius: BorderRadius.circular(12)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    SelectableText('${m['text']}'),
                    if (m['channel'] != null && m['channel'] != '控制台') Text('${m['channel']}', style: Theme.of(context).textTheme.labelSmall),
                  ]),
                ),
              );
            },
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Row(children: [
              Expanded(child: TextField(controller: input, minLines: 1, maxLines: 4, decoration: const InputDecoration(hintText: '说点什么', border: OutlineInputBorder()), onSubmitted: (_) => _send())),
              IconButton.filled(onPressed: _send, icon: const Icon(Icons.send)),
            ]),
          ),
        ),
      ]),
    );
  }
}
