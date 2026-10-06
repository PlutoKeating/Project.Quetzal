// Quetzal 控制台：观察、交流、调节与管理任意 agent。只是前端，不托管运行基座；可保存多个 agent 连接并一键切换。
//   同一份代码出两种形态：安卓 App（手机外壳：底部 Tab + 逐页推入；也是安装器与耳朵）与网页版（由运行基座的网关托管，在电脑浏览器里打开）。
//   外壳按宽度选：窄屏是手机外壳，宽屏（≥ desktopBreakpoint）是桌面外壳（shell/desktop.dart）；平板横屏也用桌面外壳。
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'markdown.dart';
import 'widgets.dart';
import 'pages/wake.dart';
import 'pages/home.dart';
import 'pages/flow.dart';
import 'pages/memory.dart';
import 'pages/control.dart';
import 'pages/about.dart';
import 'pages/pairing.dart';
import 'pages/agents.dart';
import 'pages/setup.dart';
import 'installer.dart';
import 'updater.dart';
import 'hearing.dart';
import 'platform/caps.dart';
import 'platform/fonts.dart' as fonts;
import 'platform/location.dart' as loc;
import 'platform/pin.dart';
import 'platform/tray.dart';
import 'shell/desktop.dart';

/// 暗色模式的背景：固定 RGB(32,32,32)，与主题色无关。
const darkBackground = Color(0xFF202020);

void main(List<String> args) async {
  loc.claimUrl(); // 网页版：URL 的 #片段由桌面外壳的 Nav 管理，Flutter 不改写
  WidgetsFlutterBinding.ensureInitialized();
  await fonts.loadFonts(); // 网页版：自带的中文字体子集；安卓什么都不做
  installPinning(); // 原生平台：网关的 https 连接只认配对时钉住的证书指纹（pins.dart）；网页版由浏览器处理
  api.init();
  wakes.start(); // 跟踪她正在进行的醒来（首页与心流页的只读入口）
  hearing.start(); // 耳朵：安卓上跟随基座的听觉开关启停本机的麦克风前台服务；网页版只跟着状态显示
  runApp(const ConsoleApp());
  initTray(background: args.contains('--background')); // 桌面版：右上角状态栏的托盘图标（运行基座在跑就在；关窗只是隐藏）；网页版与安卓什么都不做
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
        fontFamily: fonts.fontFamily,
        cardTheme: const CardThemeData(margin: EdgeInsets.symmetric(horizontal: 12, vertical: 6)),
      );
    }
    return ListenableBuilder(
      listenable: api,
      builder: (context, _) => MaterialApp(
        title: 'Quetzal',
        debugShowCheckedModeBanner: false,
        theme: theme(Brightness.light),
        darkTheme: theme(Brightness.dark),
        themeMode: ThemeMode.dark,
        // 外壳模式随窗口宽度：所有页面（含推入的二级页）都从这里得知自己在哪种外壳里
        builder: (context, child) => ShellScope(mode: MediaQuery.sizeOf(context).width >= desktopBreakpoint ? ShellMode.desktop : ShellMode.phone, child: child!),
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

class _ShellState extends State<Shell> with WidgetsBindingObserver {
  int tab = 0;
  String? bundled; // App 内置的运行基座版本：与运行中的不同时自动更新（本机部署才有意义）
  ShellMode? _mode;
  bool _setupChecked = false; // 电脑上第一次连上、还没有模型：打开一次向导（登录、模型），每个连接只打开一次
  Installer? _runtimeUpdate; // 正在后台把运行基座换成 App 内置的版本（每次打开 App 最多自动一次，失败了留给人点「重试」）

  /// 运行中的运行基座比 App 内置的旧（多半是刚更新了 App）：不进向导、不问，直接在后台重启成新版本，记忆与配置不受影响。
  void _updateRuntime() {
    final i = _runtimeUpdate = Installer();
    i.addListener(() async {
      if (i.done && i.token != null) await api.saveSettings(base: 'http://127.0.0.1:$runtimePort', token: i.token);
      if (mounted) setState(() {});
    });
    i.install();
  }

  void _onUpdater() { if (mounted) setState(() {}); }
  @override
  void dispose() { appUpdater.removeListener(_onUpdater); WidgetsBinding.instance.removeObserver(this); super.dispose(); }
  @override
  void didChangeAppLifecycleState(AppLifecycleState s) { if (s == AppLifecycleState.resumed && hasBody) appUpdater.onResume(); }

  /// 窗口从窄变宽：手机外壳推入的页面（对话、设置……）还压在根 Navigator 上，会盖住整个桌面外壳；收起它们，桌面外壳按 nav 的位置接着显示。
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final m = ShellScope.of(context);
    if (_mode == ShellMode.phone && m == ShellMode.desktop) {
      final navigator = Navigator.of(context);
      WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) navigator.popUntil((r) => r.isFirst); });
    }
    _mode = m;
  }
  @override
  void initState() {
    super.initState();
    if (hasBody) {
      Installer.bundledVersion().then((v) { if (mounted) setState(() => bundled = v); });
      appUpdater.addListener(_onUpdater);
      WidgetsBinding.instance.addObserver(this); // 从后台回来时再检查一次 / 接着装
      appUpdater.autoCheck(); // App 自身有没有新版：每次打开界面都问一次 GitHub（正在检查时不重复）
      appUpdater.justUpdated(); // 清掉「正在安装」的记号；运行基座落后时下面自动更新，不用它判断
    }
    api.events.listen((e) {
      if (!mounted || ShellScope.isDesktop(context)) return; // 桌面外壳自己处理
      if (e.name == 'say') toast(context, '${api.name}：${plainPreview('${e.data}')}');
      if (e.name == 'approval' && (e.data as Map)['status'] == 'pending') toast(context, '${api.name}请求：${(e.data as Map)['action']}');
    });
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: api,
      builder: (context, _) {
        if (api.conn == Conn.unpaired) return const PairingPage();
        final runtimeOutdated = bundled != null && api.conn == Conn.online && api.status['version'] != null && api.status['version'] != bundled && api.base.contains('127.0.0.1');
        if (!hasBody && !_setupChecked && api.conn == Conn.online && api.status.containsKey('models')) {
          _setupChecked = true;
          if (((api.status['models'] as List?) ?? []).isEmpty) {
            WidgetsBinding.instance.addPostFrameCallback((_) async {
              final p = await SharedPreferences.getInstance(), k = 'setup.shown.${api.current?.id}';
              if (p.getBool(k) == true || !mounted) return;
              await p.setBool(k, true);
              if (mounted) Navigator.push(this.context, MaterialPageRoute(builder: (_) => const SetupPage()));
            });
          }
        }
        if (runtimeOutdated && _runtimeUpdate == null) WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted && _runtimeUpdate == null) _updateRuntime(); });
        final ru = _runtimeUpdate;
        if (ShellScope.isDesktop(context)) return const DesktopShell();
        final pages = [const HomePage(), const FlowPage(), const MemoryPage(), const ControlPage()];
        return Scaffold(
          appBar: AppBar(
            title: const AgentSwitcher(),
            actions: [const ConnChip(), const StopButton(), const SizedBox(width: 8)],
          ),
          body: Column(children: [
            if (api.conn != Conn.online) const OfflineBanner(),
            if (api.safeMode) Banner0(text: '${api.name}反复出错，暂停了醒来', color: Colors.orange),
            if (ru != null && ru.running)
              Banner0(text: '正在更新到 $bundled…', color: Colors.blueGrey, action: const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)))
            else if (ru != null && ru.error != null)
              Banner0(text: '更新没完成', color: Colors.orange,
                  action: FilledButton.tonal(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SetupPage(upgrade: true))), child: const Text('重试')))
            else if (appUpdater.hasUpdate && !appUpdater.dismissed && appUpdater.state != UpdateState.handedOff)
              Banner0(text: '新版本 ${appUpdater.latest!.version}', color: Colors.blueGrey,
                  action: Row(mainAxisSize: MainAxisSize.min, children: [
                    FilledButton.tonal(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AboutPage())), child: const Text('更新')),
                    IconButton(onPressed: () => setState(() => appUpdater.dismissed = true), icon: const Icon(Icons.close, size: 18), tooltip: '这次先不'),
                  ])),
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
