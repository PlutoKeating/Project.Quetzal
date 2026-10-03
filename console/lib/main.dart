// Windler 控制台：观察、交流、调节与管理任意 agent。只是前端，不托管运行基座；可保存多个 agent 连接并一键切换。
import 'package:flutter/material.dart';
import 'api.dart';
import 'markdown.dart';
import 'widgets.dart';
import 'pages/wake.dart';
import 'pages/home.dart';
import 'pages/flow.dart';
import 'pages/memory.dart';
import 'pages/control.dart';
import 'pages/pairing.dart';
import 'pages/agents.dart';
import 'pages/setup.dart';
import 'installer.dart';
import 'hearing.dart';

/// 暗色模式的背景：固定 RGB(32,32,32)，与主题色无关。
const darkBackground = Color(0xFF202020);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  api.init();
  wakes.start(); // 跟踪她正在进行的醒来（首页与心流页的只读入口）
  hearing.start(); // 耳朵：跟随基座的听觉开关启停本机的麦克风前台服务
  runApp(const ConsoleApp());
}

class ConsoleApp extends StatelessWidget {
  const ConsoleApp({super.key});
  @override
  Widget build(BuildContext context) {
    ThemeData theme(Brightness b) {
      var scheme = ColorScheme.fromSeed(seedColor: api.color, brightness: b); // 主题色随当前 agent
      if (b == Brightness.dark) {
        // 暗色背景固定为中性灰 RGB(32,32,32)，各层容器为同一灰阶，不随主题色偏色
        scheme = scheme.copyWith(
          primary: api.color, // 主色直接用 agent 的主题色（M3 从种子推导的深色主色会变成偏淡的粉），文字用设计系统的 accent-fg
          onPrimary: const Color(0xFF1A120A),
          surface: darkBackground,
          surfaceContainerLowest: const Color(0xFF1A1A1A),
          surfaceContainerLow: const Color(0xFF262626),
          surfaceContainer: const Color(0xFF2C2C2C),
          surfaceContainerHigh: const Color(0xFF333333),
          surfaceContainerHighest: const Color(0xFF3A3A3A),
        );
      }
      return ThemeData(
        colorScheme: scheme,
        scaffoldBackgroundColor: b == Brightness.dark ? darkBackground : null,
        useMaterial3: true,
        cardTheme: const CardThemeData(margin: EdgeInsets.symmetric(horizontal: 12, vertical: 6)),
      );
    }
    return ListenableBuilder(
      listenable: api,
      builder: (context, _) => MaterialApp(
        title: 'Windler',
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
  String? bundled; // App 内置的运行基座版本：与运行中的不同时提示升级（本机部署才有意义）
  @override
  void initState() {
    super.initState();
    Installer.bundledVersion().then((v) { if (mounted) setState(() => bundled = v); });
    api.events.listen((e) {
      if (!mounted) return;
      if (e.name == 'say') toast(context, '${api.name}：${plainPreview('${e.data}')}');
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
            if (bundled != null && api.conn == Conn.online && api.status['version'] != null && api.status['version'] != bundled && api.base.contains('127.0.0.1'))
              Banner0(text: 'App 内置的运行基座是 $bundled，正在运行的是 ${api.status['version']}。', color: Colors.blueGrey,
                  action: FilledButton.tonal(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage(upgrade: true))), child: const Text('升级'))),
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
