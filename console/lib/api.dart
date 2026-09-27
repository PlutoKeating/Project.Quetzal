// 网关客户端：WebSocket（JSON-RPC 风格）+ 少量 HTTP（探活、配对）。整个 App 的状态都来自这里。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'igniter.dart';

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
  String get base => current?.base ?? 'http://127.0.0.1:7788';
  String get token => current?.token ?? '';
  Conn conn = Conn.unpaired;
  String lastError = '';
  Map<String, dynamic> status = {};
  bool safeMode = false;

  WebSocketChannel? _ws;
  int _seq = 0;
  final _pending = <int, Completer<dynamic>>{};
  final _events = StreamController<GatewayEvent>.broadcast();
  Stream<GatewayEvent> get events => _events.stream;
  Timer? _retry;
  int _backoff = 1;

  Future<void> init() async {
    final p = await SharedPreferences.getInstance();
    profiles = (jsonDecode(p.getString('profiles') ?? '[]') as List).map((m) => Profile.fromJson(m as Map)).toList();
    if (profiles.isEmpty) { // 迁移旧版单连接设置
      profiles.add(Profile(id: _newId(), label: '', base: p.getString('base') ?? 'http://127.0.0.1:7788', token: p.getString('token') ?? ''));
    }
    current = profiles.firstWhere((x) => x.id == p.getString('current'), orElse: () => profiles.first);
    await _persist();
    connect();
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
    if (profiles.isEmpty) profiles.add(Profile(id: _newId(), label: '', base: 'http://127.0.0.1:7788'));
    await switchTo(current == p ? profiles.first : current!);
  }

  /// 记住 agent 的显示名，离线时也能在切换列表里认出它。
  void _rememberName() {
    final n = agent['displayName'];
    if (n is String && current != null && current!.label != n) { current!.label = n; _persist(); }
  }

  // ---------- HTTP
  Future<Map<String, dynamic>> _http(String method, String path, [Map<String, dynamic>? body]) async {
    final c = HttpClient()..connectionTimeout = const Duration(seconds: 4);
    try {
      final req = await c.openUrl(method, Uri.parse('$base$path'));
      req.headers.contentType = ContentType.json;
      if (body != null) req.write(jsonEncode(body));
      final res = await req.close().timeout(const Duration(seconds: 8));
      final text = await res.transform(utf8.decoder).join();
      final j = jsonDecode(text.isEmpty ? '{}' : text) as Map<String, dynamic>;
      if (res.statusCode >= 400) throw RpcError('HTTP_${res.statusCode}', j['message'] ?? '请求失败');
      return j;
    } finally { c.close(); }
  }

  Future<bool> health() async {
    try { final j = await _http('GET', '/health'); safeMode = j['safeMode'] == true; return j['ok'] == true; } catch (_) { return false; }
  }

  Future<void> pairStart() => _http('POST', '/pair/start');
  Future<void> pairFinish(String code) async {
    final j = await _http('POST', '/pair/finish', {'code': code.trim()});
    await saveSettings(token: j['token'] as String);
  }

  // ---------- WebSocket
  void connect() {
    _retry?.cancel();
    _ws?.sink.close();
    if (token.isEmpty) { conn = Conn.unpaired; notifyListeners(); return; }
    conn = conn == Conn.igniting ? Conn.igniting : Conn.connecting;
    notifyListeners();
    final url = '${base.replaceFirst('http', 'ws')}/rpc?token=${Uri.encodeComponent(token)}';
    final ws = WebSocketChannel.connect(Uri.parse(url));
    _ws = ws;
    ws.ready.then((_) async {
      conn = Conn.online; lastError = ''; _backoff = 1;
      notifyListeners();
      await refresh();
    }).catchError((e) => _lost('$e'));
    ws.stream.listen(_onMessage, onDone: () => _lost('连接断开'), onError: (e) => _lost('$e'));
  }

  void _lost(String why) {
    if (conn == Conn.unpaired) return;
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

  Future<void> refresh() async {
    try { status = Map<String, dynamic>.from(await call<Map>('status')); _rememberName(); notifyListeners(); } catch (_) {}
  }

  /// 点火：让 Termux 启动运行基座服务，然后等待网关恢复。
  Future<String?> ignite() async {
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
    return const Color(0xFF7C6CF2);
  }
  Map get heart => (status['heart'] as Map?) ?? {};
  Map get physical => (status['physical'] as Map?) ?? {};
  bool get stopped => status['stopped'] == true;
  List get approvals => (status['approvals'] as List?) ?? [];
}

final api = Api();
