// Agent 控制台：观察、交流、调节与管理任意 agent。只是前端，不托管运行基座；可保存多个 agent 连接并一键切换。
import 'package:flutter/material.dart';
import 'api.dart';
import 'widgets.dart';
import 'pages/home.dart';
import 'pages/flow.dart';
import 'pages/memory.dart';
import 'pages/control.dart';
import 'pages/pairing.dart';
import 'pages/agents.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  api.init();
  runApp(const ConsoleApp());
}

class ConsoleApp extends StatelessWidget {
  const ConsoleApp({super.key});
  @override
  Widget build(BuildContext context) {
    ThemeData theme(Brightness b) => ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: api.color, brightness: b), // 主题色随当前 agent
          useMaterial3: true,
          cardTheme: const CardThemeData(margin: EdgeInsets.symmetric(horizontal: 12, vertical: 6)),
        );
    return ListenableBuilder(
      listenable: api,
      builder: (context, _) => MaterialApp(
        title: 'Agent 控制台',
        debugShowCheckedModeBanner: false,
        theme: theme(Brightness.light),
        darkTheme: theme(Brightness.dark),
        themeMode: ThemeMode.dark,
        home: const Shell(),
      ),
    );
  }
}

class Shell extends StatefulWidget {
  const Shell({super.key});
  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int tab = 0;
  @override
  void initState() {
    super.initState();
    api.events.listen((e) {
      if (!mounted) return;
      if (e.name == 'say') toast(context, '${api.name}：${e.data}');
      if (e.name == 'approval' && (e.data as Map)['status'] == 'pending') toast(context, '她请求批准：${(e.data as Map)['action']}');
    });
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: api,
      builder: (context, _) {
        if (api.conn == Conn.unpaired) return const PairingPage();
        final pages = [const HomePage(), const FlowPage(), const MemoryPage(), const ControlPage()];
        return Scaffold(
          appBar: AppBar(
            title: const AgentSwitcher(),
            actions: [const ConnChip(), const StopButton(), const SizedBox(width: 8)],
          ),
          body: Column(children: [
            if (api.conn != Conn.online) const OfflineBanner(),
            if (api.safeMode) const Banner0(text: '基座处于安全模式（反复崩溃后）：只能查看与管理，不会醒来。', color: Colors.orange),
            Expanded(child: pages[tab]),
          ]),
          bottomNavigationBar: NavigationBar(
            selectedIndex: tab,
            onDestinationSelected: (i) => setState(() => tab = i),
            destinations: [
              const NavigationDestination(icon: Icon(Icons.brightness_3_outlined), selectedIcon: Icon(Icons.brightness_3), label: '此刻'),
              const NavigationDestination(icon: Icon(Icons.timeline_outlined), selectedIcon: Icon(Icons.timeline), label: '心流'),
              const NavigationDestination(icon: Icon(Icons.auto_stories_outlined), selectedIcon: Icon(Icons.auto_stories), label: '记忆'),
              NavigationDestination(
                icon: Badge(isLabelVisible: api.approvals.isNotEmpty, label: Text('${api.approvals.length}'), child: const Icon(Icons.tune_outlined)),
                selectedIcon: const Icon(Icons.tune), label: '控制'),
            ],
          ),
        );
      },
    );
  }
}
