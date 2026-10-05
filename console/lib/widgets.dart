// 通用组件：外壳模式与页面框架、状态光团、驱动力条、连接状态、急停、离线横幅、提示。
import 'dart:math';
import 'package:flutter/material.dart';
import 'api.dart';

/// 外壳模式：窄屏（手机）是底部 Tab + 逐页推入；宽屏（电脑浏览器、平板横屏）是导航栏 + 列表栏 + 主区 + 「她此刻」。
enum ShellMode { phone, desktop }

/// 宽度达到这个值用桌面外壳。
const desktopBreakpoint = 900.0;

class ShellScope extends InheritedWidget {
  final ShellMode mode;
  const ShellScope({super.key, required this.mode, required super.child});
  static ShellMode of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<ShellScope>()?.mode ?? ShellMode.phone;
  static bool isDesktop(BuildContext context) => of(context) == ShellMode.desktop;
  @override
  bool updateShouldNotify(ShellScope old) => old.mode != mode;
}

/// 一个页面：手机上是 Scaffold + AppBar（可推入 / 返回）；桌面主区里是一行标题（嵌套导航里有上一页时带返回）+ 内容。
/// 所有二级页面都用它，同一份内容在两种外壳里都成立。
class PageFrame extends StatelessWidget {
  final String title;
  final List<Widget> actions;
  final Widget body;
  final Widget? bottom; // 贴底的保存栏之类
  final Widget? fab;
  final Widget? leading;
  const PageFrame({super.key, required this.title, required this.body, this.actions = const [], this.bottom, this.fab, this.leading});
  @override
  Widget build(BuildContext context) {
    if (!ShellScope.isDesktop(context)) {
      return Scaffold(appBar: AppBar(title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis), actions: actions, leading: leading), body: body, bottomSheet: bottom, floatingActionButton: fab);
    }
    final cs = Theme.of(context).colorScheme;
    final canPop = Navigator.of(context).canPop();
    return Column(children: [
      SizedBox(
        height: 52,
        child: Row(children: [
          const SizedBox(width: 12),
          leading ?? (canPop ? IconButton(tooltip: '返回', icon: const Icon(Icons.arrow_back, size: 20), onPressed: () => Navigator.of(context).pop()) : const SizedBox.shrink()),
          const SizedBox(width: 8),
          Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.titleMedium)),
          ...actions,
          const SizedBox(width: 12),
        ]),
      ),
      Divider(height: 1, color: cs.outlineVariant.withValues(alpha: 0.4)),
      Expanded(child: fab == null ? body : Stack(children: [body, Positioned(right: 24, bottom: 24, child: fab!)])),
      ?bottom,
    ]);
  }
}

/// 当前内容面板的宽度：桌面上气泡与过程卡片按主区（而不是整个窗口）的宽度限制自己。
class PaneWidth extends InheritedWidget {
  final double width;
  const PaneWidth({super.key, required this.width, required super.child});
  static double of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<PaneWidth>()?.width ?? MediaQuery.sizeOf(context).width;
  @override
  bool updateShouldNotify(PaneWidth old) => old.width != width;
}

/// 从底部升起的面板（手机）或居中的对话框（桌面）。builder 收到的 ScrollController 只在手机上非空（可拖动的面板需要它）。
Future<T?> showSheet<T>(BuildContext context, Widget Function(BuildContext context, ScrollController? scroll) builder, {double initial = 0.6, double maxWidth = 720}) {
  if (ShellScope.isDesktop(context)) {
    return showDialog<T>(context: context, builder: (c) => Dialog(
        clipBehavior: Clip.antiAlias,
        child: ConstrainedBox(constraints: BoxConstraints(maxWidth: maxWidth, maxHeight: MediaQuery.sizeOf(c).height * 0.85), child: builder(c, null))));
  }
  return showModalBottomSheet<T>(context: context, isScrollControlled: true, builder: (c) =>
      DraggableScrollableSheet(expand: false, initialChildSize: initial, maxChildSize: 0.95, builder: (c, scroll) => builder(c, scroll)));
}

void toast(BuildContext context, String text) =>
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text), behavior: SnackBarBehavior.floating, width: ShellScope.isDesktop(context) ? 440 : null));

/// 调用一个操作并在失败时提示；成功时可选提示。
Future<T?> act<T>(BuildContext context, Future<T> Function() f, {String? ok}) async {
  try {
    final r = await f();
    if (ok != null && context.mounted) toast(context, ok);
    return r;
  } catch (e) {
    if (context.mounted) toast(context, '$e');
    return null;
  }
}

Future<bool> confirm(BuildContext context, String title, String text) async =>
    await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(title: Text(title), content: Text(text), actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('确定')),
      ]),
    ) ??
    false;

String hm(num ts) {
  final d = DateTime.fromMillisecondsSinceEpoch(ts.toInt());
  return '${d.month}/${d.day} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// 呼吸的光团：睡着时缓慢暗淡，醒着时明亮，思考时加快并出现光晕粒子。
class Orb extends StatefulWidget {
  final String mode; // asleep / awake / active / stopped
  final double alertness;
  final double size;
  const Orb({super.key, required this.mode, required this.alertness, this.size = 200});
  @override
  State<Orb> createState() => _OrbState();
}

class _OrbState extends State<Orb> with SingleTickerProviderStateMixin {
  late final AnimationController c = AnimationController(vsync: this, duration: const Duration(seconds: 4))..repeat();
  @override
  void dispose() { c.dispose(); super.dispose(); }
  @override
  Widget build(BuildContext context) {
    // 光团用当前 agent 的主题色，但作为发光体要比界面上的主题色更饱和、更亮；睡着时略沉，思考时更亮
    final hsl = HSLColor.fromColor(api.color);
    final vivid = hsl.withSaturation((hsl.saturation * 1.3).clamp(0, 1)).withLightness((hsl.lightness + 0.06).clamp(0, 1));
    final color = switch (widget.mode) {
      'asleep' => vivid.withLightness((vivid.lightness - 0.08).clamp(0, 1)).toColor(),
      'active' => vivid.withLightness((vivid.lightness + 0.1).clamp(0, 1)).toColor(),
      'stopped' => const Color(0xFFFF3B30),
      _ => vivid.toColor(),
    };
    final speed = switch (widget.mode) { 'asleep' => 0.5, 'active' => 2.0, _ => 1.0 };
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: c,
        builder: (_, _) => CustomPaint(size: Size.square(widget.size), painter: _OrbPainter(c.value * speed, color, widget.mode, widget.alertness)),
      ),
    );
  }
}

class _OrbPainter extends CustomPainter {
  final double t, alert;
  final Color color;
  final String mode;
  _OrbPainter(this.t, this.color, this.mode, this.alert);
  @override
  void paint(Canvas canvas, Size s) {
    final center = s.center(Offset.zero);
    final breath = 0.5 + 0.5 * sin(t * 2 * pi);
    final r = s.width * (0.26 + 0.04 * breath);
    final glow = Paint()..shader = RadialGradient(colors: [color.withValues(alpha: 0.85 * (0.5 + 0.5 * alert)), color.withValues(alpha: 0.25 * (0.5 + 0.5 * alert)), color.withValues(alpha: 0)], stops: const [0, 0.55, 1]).createShader(Rect.fromCircle(center: center, radius: r * 2.2));
    canvas.drawCircle(center, r * 2.2, glow);
    // 球体：以球心左上 0.38r 为光源，明度沿 HSL 从 +0.28 过渡到 -0.225（保住色相与饱和度，不向白 / 黑插值），边缘压暗出体积感
    final hsl = HSLColor.fromColor(color);
    Color lit(double d) => hsl.withLightness((hsl.lightness + d).clamp(0, 1)).toColor();
    final src = center.translate(-r * .38, -r * .38);
    canvas.drawCircle(center, r, Paint()..shader = RadialGradient(
      colors: [lit(0.28), lit(0.12), color, lit(-0.225)],
      stops: const [0, 0.25, 0.6, 1],
    ).createShader(Rect.fromCircle(center: src, radius: r * 1.38)));
    // 高光点：小而亮的白色，位于光源方向
    final hi = center.translate(-r * .42, -r * .42);
    canvas.drawCircle(hi, r * 0.2, Paint()..shader = RadialGradient(colors: [Colors.white.withValues(alpha: 0.95), Colors.white.withValues(alpha: 0)]).createShader(Rect.fromCircle(center: hi, radius: r * 0.2)));
    if (mode == 'active') {
      final p = Paint()..color = Colors.white.withValues(alpha: 0.7);
      for (var i = 0; i < 12; i++) {
        final a = t * 2 * pi + i * pi / 6;
        final d = r * (1.3 + 0.25 * sin(t * 6 + i));
        canvas.drawCircle(center + Offset(cos(a) * d, sin(a) * d), 2.2, p);
      }
    }
  }

  @override
  bool shouldRepaint(_OrbPainter o) => true;
}

class DriveBar extends StatelessWidget {
  final String label;
  final double value;
  const DriveBar(this.label, this.value, {super.key});
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          SizedBox(width: 40, child: Text(label, style: Theme.of(context).textTheme.bodySmall)),
          Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(4), child: LinearProgressIndicator(value: value.clamp(0, 1), minHeight: 8))),
          SizedBox(width: 44, child: Text('${(value * 100).round()}%', textAlign: TextAlign.right, style: Theme.of(context).textTheme.bodySmall)),
        ]),
      );
}

/// 依赖 api 状态的组件基类：自己监听 api，const 实例也会随状态刷新。
abstract class ApiWidget extends StatelessWidget {
  const ApiWidget({super.key});
  Widget view(BuildContext context);
  @override
  Widget build(BuildContext context) => ListenableBuilder(listenable: api, builder: (c, _) => view(c));
}

class ConnChip extends ApiWidget {
  const ConnChip({super.key});
  @override
  Widget view(BuildContext context) {
    final (text, color) = switch (api.conn) {
      Conn.online => ('在线', Colors.green),
      Conn.connecting => ('连接中', Colors.amber),
      Conn.igniting => ('点火中', Colors.amber),
      Conn.offline => ('离线', Colors.red),
      Conn.unpaired => ('未配对', Colors.grey),
    };
    return Chip(avatar: CircleAvatar(backgroundColor: color, radius: 5), label: Text(text), visualDensity: VisualDensity.compact);
  }
}

class StopButton extends ApiWidget {
  const StopButton({super.key});
  @override
  Widget view(BuildContext context) => IconButton(
        tooltip: api.stopped ? '解除急停' : '急停',
        icon: Icon(api.stopped ? Icons.play_circle : Icons.pan_tool, color: api.stopped ? Colors.green : Colors.red),
        onPressed: api.conn != Conn.online
            ? null
            : () async {
                if (api.stopped) {
                  if (await confirm(context, '解除急停', '她会恢复自主活动。确定吗？') && context.mounted) await act(context, () => api.call('unstop'), ok: '已解除急停');
                } else if (api.peers.isEmpty) {
                  await act(context, () => api.call('stop', {'reason': '控制台急停'}), ok: '已急停：她的所有行动已冻结');
                } else {
                  final scope = await showDialog<String>(context: context, builder: (c) => AlertDialog(
                    title: const Text('急停'),
                    content: const Text('她此刻有几具身体在线。要冻结哪里的行动？'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(c), child: const Text('取消')),
                      TextButton(onPressed: () => Navigator.pop(c, 'body'), child: const Text('只停这具身体')),
                      FilledButton(onPressed: () => Navigator.pop(c, 'all'), child: const Text('所有身体')),
                    ],
                  ));
                  if (scope != null && context.mounted) await act(context, () => api.call('stop', {'reason': '控制台急停', 'scope': scope}), ok: scope == 'all' ? '已急停：所有身体的行动已冻结' : '已急停：这具身体的行动已冻结');
                }
              },
      );
}

class Banner0 extends StatelessWidget {
  final String text;
  final Color color;
  final Widget? action;
  const Banner0({super.key, required this.text, required this.color, this.action});
  @override
  Widget build(BuildContext context) => Material(
        color: color.withValues(alpha: 0.18),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(children: [Expanded(child: Text(text)), ?action]),
        ),
      );
}

class OfflineBanner extends ApiWidget {
  const OfflineBanner({super.key});
  @override
  Widget view(BuildContext context) => Banner0(
        text: api.conn == Conn.igniting ? '正在点火…' : '连不上 ${api.name}${api.lastError.isNotEmpty ? '（${api.lastError.length > 40 ? api.lastError.substring(0, 40) : api.lastError}）' : ''}',
        color: Colors.red,
        action: api.conn == Conn.igniting
            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
            : FilledButton.tonal(
                onPressed: () async { final e = await api.ignite(); if (e != null && context.mounted) toast(context, e); },
                child: const Text('点火'),
              ),
      );
}

class Section extends StatelessWidget {
  final String title;
  final List<Widget> children;
  final Widget? trailing;
  const Section(this.title, this.children, {super.key, this.trailing});
  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)), ?trailing]),
            const SizedBox(height: 8),
            ...children,
          ]),
        ),
      );
}
