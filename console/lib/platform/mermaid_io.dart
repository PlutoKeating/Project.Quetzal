// dart:io 平台的 Mermaid 图：按平台选宿主（见 mermaid.dart）。
import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'mermaid_android.dart';
import 'mermaid_linux.dart';
import 'mermaid_windows.dart';
import 'mermaid_gateway.dart';

class MermaidView extends StatelessWidget {
  final String code;
  final bool fullscreen;
  const MermaidView(this.code, {super.key, this.fullscreen = false});

  @override
  Widget build(BuildContext context) {
    if (Platform.isAndroid) return AndroidMermaid(code, fullscreen: fullscreen);
    if (Platform.isWindows) return WindowsMermaid(code, fullscreen: fullscreen);
    if (Platform.isLinux) return SnapshotMermaid(code, fullscreen: fullscreen);
    return GatewayMermaid(code, fullscreen: fullscreen);
  }
}
