// 网关客户端：WebSocket（JSON-RPC 风格）+ 少量 HTTP（探活、配对、本机登录、上传）。整个 App 的状态都来自这里。
//   令牌不放进网址（网址会进日志与历史）：HTTP 用请求头 X-Quetzal-Token，WebSocket 连上后第一条消息发 {"auth": 令牌}；
//   旧版运行基座只认 ?token=，握手被拒时退回旧方式并记住这个网关。图片预览（Image.network）仍把令牌放在网址里，见 fileUrl。
//   网页版由运行基座的网关托管：页面的来源就是网关地址，第一次打开向 /auth/local 要令牌（同一台机器免配对码）；别处的 agent 仍走配对码。
//   原生桌面版（Linux / Windows）连本机网关：先直接读家目录里的 secrets/gateway.token（同一个系统用户），读不到再问 /auth/local。
//   别的机器上的运行基座只能走 HTTPS / WSS（默认 7789，自签名证书）：连接档案记着配对时钉住的证书指纹（Profile.fp），见 pins.dart；
//   明文只用于本机回环（同一台设备上的运行基座）。旧的 http:// 局域网档案连不上时提示重新配对。
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'igniter.dart';
import 'pins.dart';
import 'platform/caps.dart';
import 'platform/desktop.dart' as desktop;
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

/// 一个 agent 的连接档案：控制台可以保存多个，一键切换。fp：https 连接钉住的证书指纹（旧档案没有，为空）；令牌只和配对时的这个指纹一起有效。
class Profile {
  String id, label, base, token, fp;
  Profile({required this.id, required this.label, required this.base, this.token = '', this.fp = ''});
  Map<String, dynamic> toJson() => {'id': id, 'label': label, 'base': base, 'token': token, 'fp': fp};
  factory Profile.fromJson(Map m) => Profile(id: m['id'], label: m['label'] ?? '', base: m['base'], token: m['token'] ?? '', fp: m['fp'] ?? '');
}

/// 配对前看到的运行基座：证书指纹（原生平台是握手时自己看到的；网页版与本机明文是运行基座报告的）、身体名、版本。
class PairInfo {
  final String fingerprint, body, version;
  const PairInfo(this.fingerprint, this.body, this.version);
}

/// 旧档案提示：新的运行基座在局域网上只提供加密连接。
const legacyLanMessage = '运行基座已改为加密连接，请重新配对';

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
    // 本机免配对：网页版没有令牌时问网关；桌面版每次启动都核对家目录里的令牌（运行基座重装或换了令牌时跟上）
    if (canLocalLogin(current!) && (current!.token.isEmpty || isDesktop)) await localLogin();
    // 旧版控制台留下的 http:// 局域网档案：照常先试（运行基座可能还没升级），连不上再回配对页，见 _lost
    connect();
  }

  /// 这个连接能不能免配对码：网页版连托管自己的网关；桌面版连本机（回环地址）的网关（读家目录里的令牌，或 GET /auth/local）。
  static bool canLocalLogin(Profile p) {
    if (loc.pageOrigin != null) return p.base == loc.pageOrigin;
    if (!isDesktop) return false;
    final h = Uri.tryParse(p.base)?.host ?? '';
    return h == '127.0.0.1' || h == 'localhost' || h == '::1';
  }

  /// 同一台机器上的控制台免配对码拿到令牌。成功返回 true；别的机器会被拒绝，退回配对码。
  ///   原生桌面版：控制台与运行基座是同一个系统用户、控制台不在沙箱里，先直接读 QUETZAL_HOME/secrets/gateway.token
  ///   （Linux 缺省 ~/.quetzal，Windows 缺省 %LOCALAPPDATA%\Quetzal\home），经一次带令牌的 status 核对才用（家目录可能属于另一份安装）；
  ///   和已保存的一样就不再核对。读不到、核对不过，且还没有令牌时，再向网关要（GET /auth/local；Windows 的网关不对原生客户端放行，只靠读文件）。
  Future<bool> localLogin() async {
    final c = current;
    if (c == null || !canLocalLogin(c)) return false;
    if (isDesktop) {
      final t = await desktop.readLocalGatewayToken();
      if (t != null && t == c.token) return true;
      if (t != null && await desktop.verifyLocalToken(Uri.tryParse(c.base)?.port ?? 7788, t)) { c.token = t; await _persist(); return true; }
      if (c.token.isNotEmpty) return false; // 已有令牌：照常用它连（连不上会提示），不必再问网关
    }
    try {
      final j = await _http('GET', '/auth/local');
      if (j['token'] is String) { c.token = j['token'] as String; await _persist(); return true; }
    } catch (_) {}
    return false;
  }

  static String _newId() => DateTime.now().microsecondsSinceEpoch.toRadixString(36);

  /// 按连接档案重建钉住的指纹（https 档案）。
  void syncPins() => pins.load(profiles.map((x) => (x.base, x.fp)));

  Future<void> _persist() async {
    syncPins();
    final p = await SharedPreferences.getInstance();
    await p.setString('profiles', jsonEncode(profiles.map((x) => x.toJson()).toList()));
    if (current != null) await p.setString('current', current!.id);
  }

  Future<void> saveSettings({String? base, String? token, String? fp}) async {
    final c = current;
    if (c == null) return;
    if (base != null && base != c.base) { c.base = base; c.fp = ''; lastError = ''; if (token == null) c.token = ''; } // 换了地址：旧的钉住与令牌都不再适用
    if (token != null) c.token = token;
    if (fp != null) c.fp = fp;
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

  bool get _secure => Uri.tryParse(base)?.scheme == 'https';

  /// 配对第一步：GET /pair/info。原生平台连 https 时以「捕获」方式握手，记下自己看到的证书指纹并钉住（还没有令牌，钉住只用于接下来的配对请求）；
  /// 看到的指纹和档案里的不同（第一次、或运行基座换了证书）就清掉旧令牌——令牌只能发给配对时核对过的那张证书。
  /// 网页版由浏览器处理证书（人在浏览器的警告页上核对），本机明文连接不需要钉住，这两种用运行基座报告的指纹。旧版运行基座没有这个接口时返回 null。
  Future<PairInfo?> pairInfo() async {
    final c = current;
    final u = Uri.tryParse(base);
    if (c == null || u == null) return null;
    final capture = _secure && !isWeb;
    if (capture) pins.startCapture(u.host, u.port);
    Map<String, dynamic> j;
    String? seen;
    try { j = await _http('GET', '/pair/info'); }
    on RpcError catch (e) { if (e.code == 'HTTP_404') return null; rethrow; }
    finally { if (capture) seen = pins.endCapture(u.host, u.port); }
    final reported = '${j['fingerprint'] ?? ''}'.toLowerCase();
    final fp = capture ? (seen ?? '') : reported;
    if (_secure && !RegExp(r'^[0-9a-f]{64}$').hasMatch(fp)) throw RpcError('TLS', '没有拿到运行基座的证书指纹');
    if (_secure && fp != c.fp) { c.fp = fp; c.token = ''; await _persist(); connect(); }
    return PairInfo(fp, '${j['body'] ?? ''}', '${j['version'] ?? ''}');
  }

  Future<void> pairStart() => _http('POST', '/pair/start');

  /// 配对最后一步。加密连接：提交配对证明（配对码与钉住的证书指纹一起算，码本身不上网络），并核对运行基座回报的指纹；
  /// 本机明文连接：直接提交配对码（同一台设备，也兼容旧版运行基座）。
  Future<void> pairFinish(String code) async {
    final c = current;
    if (c == null) return;
    if (_secure) {
      if (c.fp.isEmpty) throw RpcError('TLS', '还没有核对证书指纹，请先重新探测');
      final fp = c.fp;
      final j = await _http('POST', '/pair/finish', {'proof': await pairProof(code, fp)});
      if ('${j['fingerprint'] ?? ''}'.toLowerCase() != fp) throw RpcError('TLS', '运行基座回报的证书指纹与握手时看到的不一致，可能有人在中间，已放弃');
      await saveSettings(token: j['token'] as String, fp: fp);
      return;
    }
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
    if (_secure && !isWeb && current!.fp.isEmpty) { conn = Conn.unpaired; lastError = legacyLanMessage; notifyListeners(); return; } // 加密连接没有钉住的指纹：令牌不能发出去
    conn = conn == Conn.igniting ? Conn.igniting : Conn.connecting;
    notifyListeners();
    final gw = base;
    legacy = legacy || _legacyWsAuth.contains(gw);
    final url = '${gw.replaceFirst('http', 'ws')}/rpc${legacy ? '?token=${Uri.encodeComponent(token)}' : ''}';
    final ws = net.wsConnect(Uri.parse(url));
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
    if (!isWeb && current != null && isLegacyLan(current!.base)) { // 旧的明文局域网档案：新的运行基座只在本机提供明文，回到配对页换加密地址
      _wsSub?.cancel(); _wsSub = null; _ws = null;
      for (final c in _pending.values) { if (!c.isCompleted) c.completeError(RpcError('OFFLINE', legacyLanMessage)); }
      _pending.clear();
      lastError = legacyLanMessage; conn = Conn.unpaired; notifyListeners();
      return;
    }
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
    if (ev.name == 'rpc.progress' && ev.data is Map) { _alive[(ev.data as Map)['id']]?.call(); return; } // 基座还在处理这个请求：重新计时
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
    // 「无进展」超时：基座处理期间每 10 秒推 rpc.progress，收到就重新计时；90 秒什么都没收到才判超时（旧版基座不推，就是 90 秒）
    Timer? t;
    void arm() {
      t?.cancel();
      t = Timer(const Duration(seconds: 90), () {
        if (c.isCompleted) return;
        _pending.remove(id); _alive.remove(id);
        c.completeError(RpcError('TIMEOUT', '90 秒没有收到任何进展'));
      });
    }
    _alive[id] = arm;
    arm();
    ws.sink.add(jsonEncode({'id': id, 'method': method, 'params': params ?? {}}));
    return c.future.whenComplete(() { t?.cancel(); _alive.remove(id); }).then((v) => v as T);
  }
  final _alive = <int, void Function()>{};

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
    if (!hasBody) return '在那台设备上启动 Quetzal';
    conn = Conn.igniting; notifyListeners();
    final err = await Igniter.ignite();
    if (err != null) { conn = Conn.offline; lastError = err; notifyListeners(); return err; }
    for (var i = 0; i < 20; i++) {
      await Future.delayed(const Duration(seconds: 1));
      if (await health()) { conn = Conn.connecting; connect(); return null; }
    }
    conn = Conn.offline; lastError = '启动后 20 秒内没有响应';
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
