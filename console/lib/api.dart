// 网关客户端：WebSocket（JSON-RPC 风格）+ 少量 HTTP（探活、配对、本机登录、上传）。整个 App 的状态都来自这里。
//   令牌不放进网址（网址会进日志与历史）：HTTP 用请求头 X-Quetzal-Token，WebSocket 连上后第一条消息发 {"auth": 令牌}；
//   旧版运行基座只认 ?token=，握手被拒时退回旧方式并记住这个网关。图片预览（Image.network）仍把令牌放在网址里，见 fileUrl。
//   网页版由运行基座的网关托管：页面的来源就是网关地址，第一次打开向 /auth/local 要令牌（同一台机器免配对码）；别处的 agent 仍走配对码。
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'igniter.dart';
import 'platform/caps.dart';
import 'platform/location.dart' as loc;
import 'platform/net.dart' as net;

/// 缺省的网关地址：网页版是页面自己的来源，安卓是本机。
String get defaultBase => loc.pageOrigin ?? 'http://127.0.0.1:7788';

enum Conn { unpaired, connecting, online, offline, igniting }

class RpcError implements Exception {
  final String code, message;
  RpcError(this.code, this.message);
  @override
  String toString() => message;
}

/// 一个 agent 的连接档案：控制台可以保存多个，一键切换。
class Profile {
  String id, label, base, token;
  Profile({required this.id, required this.label, required this.base, this.token = ''});
  Map<String, dynamic> toJson() => {'id': id, 'label': label, 'base': base, 'token': token};
  factory Profile.fromJson(Map m) => Profile(id: m['id'], label: m['label'] ?? '', base: m['base'], token: m['token'] ?? '');
}

class GatewayEvent {
  final String name;
  final dynamic data;
  GatewayEvent(this.name, this.data);
}

class Api extends ChangeNotifier {
  List<Profile> profiles = [];
  Profile? current;
  String get base => current?.base ?? defaultBase;
  String get token => current?.token ?? '';
  Conn conn = Conn.unpaired;
  String lastError = '';
  Map<String, dynamic> status = {};
  bool safeMode = false;

  WebSocketChannel? _ws;
  StreamSubscription? _wsSub; // 当前连接的监听；换连接时注销，旧连接迟到的关闭事件不再影响状态
  int _seq = 0;
  final _pending = <int, Completer<dynamic>>{};
  final _events = StreamController<GatewayEvent>.broadcast();
  Stream<GatewayEvent> get events => _events.stream;
  Timer? _retry;
  int _backoff = 1;
  final _legacyWsAuth = <String>{}; // 只认 ?token= 的旧版运行基座（按网关地址，本次运行内记住）

  Future<void> init() async {
    final p = await SharedPreferences.getInstance();
    profiles = (jsonDecode(p.getString('profiles') ?? '[]') as List).map((m) => Profile.fromJson(m as Map)).toList();
    if (profiles.isEmpty) { // 迁移旧版单连接设置
      profiles.add(Profile(id: _newId(), label: '', base: p.getString('base') ?? defaultBase, token: p.getString('token') ?? ''));
    }
    current = profiles.firstWhere((x) => x.id == p.getString('current'), orElse: () => profiles.first);
    // 网页版：托管这个页面的网关就是它自己的 agent；第一次打开把它加进来并选中
    final origin = loc.pageOrigin;
    if (origin != null && !profiles.any((x) => x.base == origin)) { current = Profile(id: _newId(), label: '', base: origin); profiles.insert(0, current!); }
    await _persist();
    if (current!.token.isEmpty && canLocalLogin(current!)) await localLogin();
    connect();
  }

  /// 这个连接能不能免配对码：网页版连托管自己的网关；桌面版连本机（回环地址）的网关。网关只对回环连接放行（GET /auth/local）。
  static bool canLocalLogin(Profile p) {
    if (loc.pageOrigin != null) return p.base == loc.pageOrigin;
    if (!isDesktop) return false;
    final h = Uri.tryParse(p.base)?.host ?? '';
    return h == '127.0.0.1' || h == 'localhost' || h == '::1';
  }

  /// 同一台机器上的控制台直接向网关要令牌（GET /auth/local）。成功返回 true；别的机器会被拒绝，退回配对码。
  Future<bool> localLogin() async {
    final c = current;
    if (c == null || !canLocalLogin(c)) return false;
    try {
      final j = await _http('GET', '/auth/local');
      if (j['token'] is String) { c.token = j['token'] as String; await _persist(); return true; }
    } catch (_) {}
    return false;
  }

  static String _newId() => DateTime.now().microsecondsSinceEpoch.toRadixString(36);

  Future<void> _persist() async {
    final p = await SharedPreferences.getInstance();
    await p.setString('profiles', jsonEncode(profiles.map((x) => x.toJson()).toList()));
    if (current != null) await p.setString('current', current!.id);
  }

  Future<void> saveSettings({String? base, String? token}) async {
    final c = current;
    if (c == null) return;
    if (base != null) c.base = base;
    if (token != null) c.token = token;
    await _persist();
    connect();
  }

  /// 切换到另一个 agent。
  Future<void> switchTo(Profile p) async {
    current = p; status = {}; safeMode = false;
    await _persist();
    connect();
  }

  /// 新增一个 agent 连接（进入配对流程）。
  Future<void> addProfile(String base) async {
    final p = Profile(id: _newId(), label: '', base: base);
    profiles.add(p);
    await switchTo(p);
  }

  Future<void> removeProfile(Profile p) async {
    profiles.remove(p);
    if (profiles.isEmpty) profiles.add(Profile(id: _newId(), label: '', base: defaultBase));
    await switchTo(current == p ? profiles.first : current!);
  }

  /// 记住 agent 的显示名，离线时也能在切换列表里认出它。
  void _rememberName() {
    final n = agent['displayName'];
    if (n is String && current != null && current!.label != n) { current!.label = n; _persist(); }
  }

  // ---------- HTTP（平台层：安卓 dart:io，网页 XMLHttpRequest）
  Future<Map<String, dynamic>> _http(String method, String path, [Map<String, dynamic>? body]) async {
    final res = await net.request(method, '$base$path', json: body == null ? null : jsonEncode(body));
    Map<String, dynamic> j;
    try { j = jsonDecode(res.body.isEmpty ? '{}' : res.body) as Map<String, dynamic>; } catch (_) { j = {}; }
    if (res.status >= 400) throw RpcError('HTTP_${res.status}', j['message'] ?? '请求失败（${res.status}）');
    return j;
  }

  Future<bool> health() async {
    try { final j = await _http('GET', '/health'); safeMode = j['safeMode'] == true; return j['ok'] == true; } catch (_) { return false; }
  }

  /// 带令牌的请求头：X-Quetzal-Token；x-token 给旧版运行基座。
  Map<String, String> get authHeaders => token.isEmpty ? const {} : {'X-Quetzal-Token': token, 'x-token': token};

  /// 上传一个附件（原始字节），返回附件信息；onProgress 报告已发送的比例。
  Future<Map<String, dynamic>> upload(String name, Uint8List bytes, {void Function(double)? onProgress}) async {
    final url = Uri.parse('$base/upload').replace(queryParameters: {'name': name}).toString();
    final res = await net.upload(url, bytes, headers: authHeaders, onProgress: onProgress);
    Map<String, dynamic> j;
    try { j = jsonDecode(res.body) as Map<String, dynamic>; } catch (_) { j = {}; }
    if (res.status >= 400 || j['ok'] != true) throw RpcError('UPLOAD', '${j['message'] ?? '上传失败（${res.status}）'}');
    return Map<String, dynamic>.from(j['file'] as Map);
  }

  /// 附件的下载地址（图片预览）。Image.network 在网页版由浏览器按网址加载、带不了自定义请求头，所以这里仍用 ?token=（只发给同一个网关）。
  String fileUrl(String rel) => Uri.parse('$base/uploads/${rel.split('/').map(Uri.encodeComponent).join('/')}').replace(queryParameters: {'token': token}).toString();

  Future<void> pairStart() => _http('POST', '/pair/start');
  Future<void> pairFinish(String code) async {
    final j = await _http('POST', '/pair/finish', {'code': code.trim()});
    await saveSettings(token: j['token'] as String);
  }

  // ---------- WebSocket
  /// 连接网关。[legacy]：用旧方式（令牌放在 ?token=）；默认先用第一条消息认证，握手被拒或认证前就断开时自动退回旧方式再试一次。
  void connect({bool legacy = false}) {
    _retry?.cancel();
    // 先注销旧连接的监听再关闭它：否则旧连接的 onDone 会迟到，把刚连上的新连接误判为断开，再次重连……
    // 形成每隔几秒闪一下「不在线」的循环（每轮约一次握手的时间）
    _wsSub?.cancel(); _wsSub = null;
    _ws?.sink.close(); _ws = null;
    if (token.isEmpty) { conn = Conn.unpaired; notifyListeners(); return; }
    conn = conn == Conn.igniting ? Conn.igniting : Conn.connecting;
    notifyListeners();
    final gw = base;
    legacy = legacy || _legacyWsAuth.contains(gw);
    final url = '${gw.replaceFirst('http', 'ws')}/rpc${legacy ? '?token=${Uri.encodeComponent(token)}' : ''}';
    final ws = WebSocketChannel.connect(Uri.parse(url));
    _ws = ws;
    var heard = false; // 收到过网关的消息：认证已被接受
    Timer? authWait;
    void online() {
      authWait?.cancel();
      if (_ws != ws || conn == Conn.online) return;
      conn = Conn.online; lastError = ''; _backoff = 1;
      notifyListeners();
      refresh();
    }
    void fail(String why) {
      authWait?.cancel();
      if (_ws != ws) return;
      if (!legacy && !heard) { connect(legacy: true); return; } // 旧版运行基座：握手时就要 ?token=
      _lost(why);
    }
    ws.ready.then((_) {
      if (_ws != ws) return; // 等待握手期间已经换了连接
      if (legacy) { online(); return; }
      ws.sink.add(jsonEncode({'auth': token}));
      authWait = Timer(const Duration(seconds: 6), online); // 认证通过后网关会推 hello；没推也不拦着
    }).catchError((e) => fail('$e'));
    _wsSub = ws.stream.listen((raw) {
      if (_ws != ws) return;
      if (!heard) { heard = true; if (legacy) _legacyWsAuth.add(gw); online(); }
      _onMessage(raw);
    }, onDone: () => fail('连接断开'), onError: (e) => fail('$e'));
  }

  void _lost(String why) {
    if (conn == Conn.unpaired) return;
    _wsSub?.cancel(); _wsSub = null; _ws = null; // 这条连接已经没用了；同一条连接的 onError 与 onDone 只算一次
    lastError = why;
    if (conn != Conn.igniting) conn = Conn.offline;
    for (final c in _pending.values) { if (!c.isCompleted) c.completeError(RpcError('OFFLINE', '未连接')); }
    _pending.clear();
    notifyListeners();
    _retry?.cancel();
    _retry = Timer(Duration(seconds: _backoff), connect); // 重连退避：1、2、4…最多 30 秒
    _backoff = (_backoff * 2).clamp(1, 30);
  }

  void _onMessage(dynamic raw) {
    final m = jsonDecode(raw as String) as Map<String, dynamic>;
    if (m.containsKey('id')) {
      final c = _pending.remove(m['id']);
      if (c == null) return;
      if (m['error'] != null) { c.completeError(RpcError('${m['error']['code']}', '${m['error']['message']}')); } else { c.complete(m['result']); }
      return;
    }
    final ev = GatewayEvent(m['event'] as String, m['data']);
    if (ev.name == 'state') { status = Map<String, dynamic>.from(ev.data as Map); _rememberName(); notifyListeners(); }
    if (ev.name == 'mesh' && ev.data is Map) { status['mesh'] = ev.data; notifyListeners(); } // 网状层的状态单独推送（绑定进展、各身体的连接）
    if (ev.name == 'account' && ev.data is Map) { status['account'] = ev.data; notifyListeners(); } // 账户的控制台登录状态（申请码、批准、退出、令牌失效）
    if (ev.name == 'hello') safeMode = (ev.data as Map)['safeMode'] == true;
    _events.add(ev);
  }

  Future<T> call<T>(String method, [Map<String, dynamic>? params]) {
    final ws = _ws;
    if (ws == null || conn != Conn.online) return Future.error(RpcError('OFFLINE', '未连接到 agent'));
    final id = ++_seq;
    final c = Completer<dynamic>();
    _pending[id] = c;
    ws.sink.add(jsonEncode({'id': id, 'method': method, 'params': params ?? {}}));
    return c.future.timeout(const Duration(seconds: 90)).then((v) => v as T);
  }

  /// 长时间运行的调用（如对话）：不设绝对超时，而是「无进展」超时——
  /// 每收到一个满足 isProgress 的推送（模型流式文字、工具执行、心跳……）就重新计时，idle 内毫无动静才判定超时。
  Future<T> callLive<T>(String method, Map<String, dynamic> params, {required bool Function(GatewayEvent) isProgress, Duration idle = const Duration(seconds: 120)}) {
    final ws = _ws;
    if (ws == null || conn != Conn.online) return Future.error(RpcError('OFFLINE', '未连接到 agent'));
    final id = ++_seq;
    final c = Completer<dynamic>();
    _pending[id] = c;
    Timer? t;
    void arm() {
      t?.cancel();
      t = Timer(idle, () {
        if (c.isCompleted) return;
        _pending.remove(id);
        c.completeError(RpcError('TIMEOUT', '${idle.inSeconds} 秒没有收到任何进展'));
      });
    }
    final sub = _events.stream.where(isProgress).listen((_) => arm());
    arm();
    ws.sink.add(jsonEncode({'id': id, 'method': method, 'params': params}));
    return c.future.whenComplete(() { t?.cancel(); sub.cancel(); }).then((v) => v as T);
  }

  /// 从后台切回时调用：手机可能已经悄悄断开了连接（但本地还以为在线），探测一下，失效就重连。
  Future<void> ensureAlive() async {
    if (conn != Conn.online) { connect(); return; }
    try { await call<Map>('status').timeout(const Duration(seconds: 5)); } catch (_) { connect(); }
  }

  Future<void> refresh() async {
    try { status = Map<String, dynamic>.from(await call<Map>('status')); _rememberName(); notifyListeners(); } catch (_) {}
  }

  /// 点火：让 Termux 启动运行基座服务，然后等待网关恢复。只有安卓 App 能做。
  Future<String?> ignite() async {
    if (!hasBody) return '这个控制台不能点火：在装运行基座的那台机器上 quetzal start，或在手机的 Quetzal App 里点火';
    conn = Conn.igniting; notifyListeners();
    final err = await Igniter.ignite();
    if (err != null) { conn = Conn.offline; lastError = err; notifyListeners(); return err; }
    for (var i = 0; i < 20; i++) {
      await Future.delayed(const Duration(seconds: 1));
      if (await health()) { conn = Conn.connecting; connect(); return null; }
    }
    conn = Conn.offline; lastError = '点火后 20 秒内没有响应';
    notifyListeners();
    return lastError;
  }

  // ---------- 便捷访问
  Map get agent => (status['agent'] as Map?) ?? {};
  String get name => (agent['displayName'] as String?) ?? (current?.label.isNotEmpty == true ? current!.label : 'Agent');
  Color get color {
    final c = agent['color'];
    if (c is String && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(c)) return Color(int.parse('FF${c.substring(1)}', radix: 16));
    return defaultAgentColor;
  }
  Map get heart => (status['heart'] as Map?) ?? {};
  Map get physical => (status['physical'] as Map?) ?? {};
  bool get stopped => status['stopped'] == true;
  List get approvals => (status['approvals'] as List?) ?? [];
  /// 这具身体的名字；多具身体时，别处发生的事标出在哪具身体上。
  String get body => '${status['body'] ?? ''}';
  /// 多具身体时其他在线的身体（不含这具）。
  List<Map> get peers => (((status['mesh'] as Map?)?['peers'] as List?) ?? []).cast<Map>().where((p) => p['online'] == true).toList();
}

/// 默认主题色：与官网设计系统的琥珀（accent）一致。
const defaultAgentColor = Color(0xFFF0A35E);

final api = Api();
