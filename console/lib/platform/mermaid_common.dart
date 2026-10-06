// Mermaid 图在各个宿主之间共用的小部件：渲染失败时的提示与源码、点开全屏。
import 'package:flutter/material.dart';

/// 画不出来：一行原因 + 源码（可选中复制）。
class MermaidFailed extends StatelessWidget {
  final String code;
  final String? error;
  const MermaidFailed(this.code, {super.key, this.error});
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(error == null ? '图表无法渲染' : '图表无法渲染：$error', style: TextStyle(color: cs.error, fontSize: 12)),
      SelectableText(code, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
    ]);
  }
}

/// 全屏查看一张图（桌面上盖住整个窗口，而不是只在主区里推入）。
void openMermaidFullscreen(BuildContext context, Widget Function() view) {
  showDialog(context: context, useRootNavigator: true, builder: (x) => Dialog.fullscreen(
      child: Column(children: [
        AppBar(title: const Text('图表'), leading: IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(x))),
        Expanded(child: view()),
      ])));
}

/// 内嵌的图：点一下全屏。
Widget tapToFullscreen(BuildContext context, Widget child, Widget Function() fullscreen) => GestureDetector(
    behavior: HitTestBehavior.opaque, onTap: () => openMermaidFullscreen(context, fullscreen), child: child);

/// 缓存的上限：最近用过的放最后，超了丢最早的。
void putBounded<K, V>(Map<K, V> cache, K key, V value, {int max = 48}) {
  cache.remove(key);
  cache[key] = value;
  while (cache.length > max) { cache.remove(cache.keys.first); }
}
