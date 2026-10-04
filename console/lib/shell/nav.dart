// 桌面外壳的位置：在哪一区（对话 / 心流 / 记忆 / 控制）、打开了哪一条。
//   网页版把它同步进 URL 的 #片段（#/chat/<会话>、#/flow/<经历>、#/memory/notes/<笔记>、#/control/providers），可收藏、可前进后退；安卓没有 URL，只在内存里。
import 'package:flutter/foundation.dart';
import '../platform/location.dart' as loc;

typedef Place = ({String section, String? sub, String? id});

class Nav extends ChangeNotifier {
  String section = 'chat';
  String? sub, id;

  Nav() {
    _apply(parse(loc.hash));
    loc.hashChanges.listen((h) { if (_apply(parse(h))) notifyListeners(); });
  }

  static const sections = ['chat', 'flow', 'memory', 'control'];

  /// '#/memory/notes/身体%2Fhonor9' → (memory, notes, 身体/honor9)
  static Place parse(String hash) {
    final parts = hash.replaceFirst(RegExp(r'^#?/?'), '').split('/').where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty || !sections.contains(parts[0])) return (section: 'chat', sub: null, id: null);
    String? dec(String? s) => s == null ? null : Uri.decodeComponent(s);
    if (parts[0] == 'memory') return (section: 'memory', sub: parts.length > 1 ? parts[1] : null, id: dec(parts.length > 2 ? parts.sublist(2).join('/') : null));
    return (section: parts[0], sub: null, id: dec(parts.length > 1 ? parts.sublist(1).join('/') : null));
  }

  String get path => ['/$section', ?sub, if (id != null) Uri.encodeComponent(id!)].join('/');

  bool _apply(Place p) {
    if (p.section == section && p.sub == sub && p.id == id) return false;
    section = p.section; sub = p.sub; id = p.id;
    return true;
  }

  void go(String section, {String? sub, String? id}) {
    if (!_apply((section: section, sub: sub, id: id))) return;
    notifyListeners();
    loc.hash = '#$path';
  }
}

final nav = Nav();
